/**
 * Managed local server lifecycle shared by the Pi client.
 *
 * `ensure()` reuses any compatible server at the configured baseUrl; only when nothing is
 * listening on a *loopback* address does it start one, under a per-address lock so concurrent
 * clients converge on a single instance. A started server runs as a child of a detached logging
 * supervisor, so it survives the client and is never killed by it, and the supervisor's pid, the
 * actual server pid, and the log path are recorded in a client-owned directory.
 *
 * Ownership is proven, never guessed: the client spawns the supervisor with a fresh nonce and
 * only claims the server when the answering ping pid equals the supervisor's recorded
 * `server_pid` and the proof's `launcher_pid` is the supervisor it spawned. A peer that wins the
 * race is reused and our own (non-serving) supervisor is reclaimed; a foreign listener is never
 * treated as absent and never killed.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError, BridgeHttpClient } from "./client.ts";
import { collectSecrets, redactText, redactValue } from "./redact.mjs";
import { isLoopback, resolveServerLaunch, type BridgeSettings } from "./config.ts";
export interface EnsureResult {
  baseUrl: string;
  owned: boolean;
  /** The actual HTTP server pid (from ping/proof), or null when reused. */
  pid: number | null;
  /** The detached logging supervisor pid, or null when reused. */
  loggerPid: number | null;
}
export type ProbeResult = "ok" | "down" | "incompatible";

/** Private, per-launch identity handed from the client to the supervisor. */
interface Launch { childPid: number | null; nonce: string; proofPath: string; logPath: string; spawnError: Error | null }
/** The supervisor's private proof file: ties the nonce to the supervisor and the server pid. */
interface Proof { nonce: string; launcher_pid: number; server_pid: number | null; error?: string }

const PROBE_TIMEOUT_MS = 2000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

export function clientDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.HARNESS_ACP_BRIDGE_CLIENT_DIR ?? join(homedir(), ".harness-acp-bridge-client");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const SENSITIVE = /token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?key/i;

/** Strip terminal control sequences and mask credential-looking values from diagnostics. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let output = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 6 && SENSITIVE.test(key)) output = output.split(value).join("[redacted]");
  }
  return output
    .replace(/\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{6,})/gi, "$1 [redacted]")
    .replace(/([A-Za-z0-9_.'"-]*(?:token|secret|password|api[_-]?key|credential)[A-Za-z0-9_.'"-]*)(\s*[:=]\s*)([^\n,}]+)/gi, "$1$2[redacted]");
}

function logTail(path: string, secrets: readonly string[]): string {
  try { return redactText(readFileSync(path, "utf8").slice(-4000), secrets).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim(); }
  catch { return ""; }
}

export class ServerLifecycle {
  private readonly dir: string;
  private readonly baseUrl: string;
  private readonly settings: BridgeSettings;
  private readonly env: NodeJS.ProcessEnv;
  private readonly baseCwd: string;
  private readonly secrets: readonly string[];
  private readonly probeClient: BridgeHttpClient;

  constructor(settings: BridgeSettings, env: NodeJS.ProcessEnv = process.env, baseCwd: string = process.cwd()) {
    this.settings = settings;
    this.baseUrl = settings.baseUrl;
    this.dir = clientDirectory(env);
    this.env = env;
    this.baseCwd = baseCwd;
    this.secrets = collectSecrets(env);
    this.probeClient = new BridgeHttpClient({ ...settings, baseUrl: settings.baseUrl, requestTimeoutMs: PROBE_TIMEOUT_MS });
  }

  async probe(): Promise<ProbeResult> {
    try {
      const data = await this.probeClient.call("ping", {});
      return data.status === "ok" && data.protocol_version === 3 ? "ok" : "incompatible";
    } catch (error) {
      if (error instanceof BridgeError && error.code === "network_error") return "down";
      return "incompatible";
    }
  }

  private async probePid(): Promise<number | null> {
    try {
      const data = await this.probeClient.call("ping", {});
      return data.status === "ok" && data.protocol_version === 3 && typeof data.pid === "number" ? data.pid : null;
    } catch { return null; }
  }

  async ensure(): Promise<EnsureResult> {
    const state = await this.probe();
    if (state === "ok") return { baseUrl: this.baseUrl, owned: false, pid: null, loggerPid: null };
    if (state === "incompatible") throw this.incompatible();
    if (!this.settings.autoStart) {
      throw new BridgeError("server_unreachable", `no harness-acp-bridge server at ${this.baseUrl} and autoStart is disabled`);
    }
    if (!isLoopback(this.baseUrl)) {
      throw new BridgeError("server_unreachable", `no harness-acp-bridge server at ${this.baseUrl}; refusing to start a local server for a non-loopback address`);
    }
    return this.startLocal();
  }

  private incompatible(): BridgeError {
    return new BridgeError("incompatible_server", `a service at ${this.baseUrl} answered but is not a compatible harness-acp-bridge server (protocol 3)`);
  }

  private async startLocal(): Promise<EnsureResult> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const key = this.baseUrl.replace(/[^A-Za-z0-9]+/g, "_");
    const release = await this.acquireLock(join(this.dir, `start-${key}.lock`));
    try {
      // Another client may have started it while we waited for the lock; a foreign listener that
      // appeared meanwhile must likewise never be treated as absent.
      const state = await this.probe();
      if (state === "ok") return { baseUrl: this.baseUrl, owned: false, pid: null, loggerPid: null };
      if (state === "incompatible") throw this.incompatible();

      const logPath = join(this.dir, `server-${key}.log`);
      const proofPath = join(this.dir, `launch-${key}.json`);
      const nonce = randomBytes(16).toString("hex");
      try { unlinkSync(proofPath); } catch { /* no stale proof */ }

      // Resolve the entry once (explicit serverEntry → PATH hacpd → installed module) and pass
      // exactly one kind-specific internal variable. Any inherited value of the other kind is
      // cleared so a stray HARNESS_ACP_BRIDGE_SERVER_COMMAND in the environment can never hijack
      // the spawn — only this fixed-name PATH lookup may select a command.
      const plan = resolveServerLaunch(this.settings, this.env, this.baseCwd);
      const env: NodeJS.ProcessEnv = {
        ...this.env,
        HARNESS_ACP_BRIDGE_LOG: logPath,
        HARNESS_ACP_BRIDGE_PROOF: proofPath,
        HARNESS_ACP_BRIDGE_NONCE: nonce,
      };
      delete env.HARNESS_ACP_BRIDGE_SERVER_MODULE;
      delete env.HARNESS_ACP_BRIDGE_SERVER_COMMAND;
      if (plan.kind === "module") env.HARNESS_ACP_BRIDGE_SERVER_MODULE = plan.specifier;
      else env.HARNESS_ACP_BRIDGE_SERVER_COMMAND = plan.command;
      if (this.settings.configPath) env.HARNESS_ACP_BRIDGE_CONFIG = this.settings.configPath;

      const launch: Launch = { childPid: null, nonce, proofPath, logPath, spawnError: null };
      try {
        const child = spawn(process.execPath, [fileURLToPath(new URL("./bootstrap.mjs", import.meta.url))], { detached: true, stdio: "ignore", env, cwd: this.dir });
        child.on("error", error => { launch.spawnError = error; });
        child.unref();
        launch.childPid = child.pid ?? null;
      } catch (error) {
        throw new BridgeError("startup_failed", `could not launch the harness-acp-bridge supervisor at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const deadline = Date.now() + this.settings.startupTimeoutMs;
      while (Date.now() < deadline) {
        const claimed = await this.claim(launch);
        if (claimed) return claimed;
        if (launch.childPid === null || !alive(launch.childPid)) break;
        await sleep(100);
      }
      // The final probe uses the same ownership check, so a child that only becomes ready at the
      // deadline is recorded as ours instead of being reclaimed.
      const claimed = await this.claim(launch);
      if (claimed) return claimed;
      this.reclaimLaunch(launch);
      const detail = this.readProof(launch.proofPath, launch.nonce)?.error ?? launch.spawnError?.message ?? null;
      const tail = logTail(logPath, this.secrets);
      throw new BridgeError("startup_failed", `could not start a harness-acp-bridge server at ${this.baseUrl} within ${this.settings.startupTimeoutMs}ms${detail ? ` (${detail})` : ""}${tail ? `\nserver log: ${tail}` : ""}`);
    } finally {
      await release();
    }
  }

  /**
   * Resolve a probe into a result, or `null` to keep waiting. Ownership is claimed only when the
   * answering pid matches the server pid the launched supervisor recorded *and* the record was
   * signed with our nonce by the supervisor we spawned. A peer that won the race is reused and our
   * own (non-serving) supervisor is reclaimed.
   */
  private async claim(launch: Launch): Promise<EnsureResult | null> {
    const state = await this.probe();
    if (state === "ok") {
      const pingPid = await this.probePid();
      const proof = this.readProof(launch.proofPath, launch.nonce);
      if (pingPid !== null && proof && proof.server_pid === pingPid && proof.launcher_pid === launch.childPid) {
        this.record(pingPid, proof.launcher_pid, launch.logPath);
        return { baseUrl: this.baseUrl, owned: true, pid: pingPid, loggerPid: proof.launcher_pid };
      }
      this.reclaimLaunch(launch);
      return { baseUrl: this.baseUrl, owned: false, pid: null, loggerPid: null };
    }
    if (state === "incompatible") { this.reclaimLaunch(launch); throw this.incompatible(); }
    return null;
  }

  /**
   * Stop only the supervisor we spawned and the server it recorded — never a peer or foreign
   * service. Killing the supervisor closes its end of the server's stdin watchdog, so the child
   * exits too; the recorded server pid is a belt-and-braces second target.
   */
  private reclaimLaunch(launch: Launch): void {
    const proof = this.readProof(launch.proofPath, launch.nonce);
    if (proof && typeof proof.server_pid === "number") this.terminate(proof.server_pid);
    if (launch.childPid !== null) this.terminate(launch.childPid);
  }

  private terminate(pid: number): void {
    try { if (alive(pid)) process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }

  /** Read a proof file only when it was written by the supervisor we spawned (nonce match). */
  private readProof(path: string, nonce: string): Proof | null {
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as Partial<Proof>;
      if (typeof data.launcher_pid === "number" && data.nonce === nonce) {
        return {
          nonce,
          launcher_pid: data.launcher_pid,
          server_pid: typeof data.server_pid === "number" ? data.server_pid : null,
          error: typeof data.error === "string" ? data.error : undefined,
        };
      }
    } catch { /* no proof written yet */ }
    return null;
  }

  private record(serverPid: number | null, loggerPid: number | null, logPath: string): void {
    const file = join(this.dir, "servers.json");
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { data = {}; }
    data[this.baseUrl] = { pid: serverPid, logger_pid: loggerPid, log: logPath, started_at: new Date().toISOString() };
    // Sanitize the persisted copy before the atomic write. Top-level map keys are baseUrls
    // (already validated credential-free) and stay intact so readServerRegistry and the
    // ownership claim keep working; nested credential-bearing values are masked.
    const sanitized = redactValue(data, this.secrets);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  private async acquireLock(path: string): Promise<() => Promise<void>> {
    const end = Date.now() + this.settings.startupTimeoutMs;
    for (;;) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        closeSync(fd);
        return async () => { try { if (readLockPid(path) === process.pid) unlinkSync(path); } catch { /* best effort */ } };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = readLockPid(path);
        if (owner !== null && !alive(owner)) { try { unlinkSync(path); } catch { /* retry */ } continue; }
        if (Date.now() > end) throw new BridgeError("startup_locked", `another client is starting a harness-acp-bridge server at ${this.baseUrl}`);
        await sleep(100);
      }
    }
  }
}

function readLockPid(path: string): number | null {
  try { const data = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }; return typeof data.pid === "number" ? data.pid : null; }
  catch { return null; }
}

export function readServerRegistry(dir = clientDirectory()): Record<string, { pid: number | null; logger_pid: number | null; log: string; started_at: string }> {
  const file = join(dir, "servers.json");
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, { pid: number | null; logger_pid: number | null; log: string; started_at: string }>; }
  catch { return {}; }
}
