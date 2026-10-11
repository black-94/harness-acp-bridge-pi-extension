/**
 * Managed local server lifecycle shared by the Pi client.
 *
 * `ensure()` reuses any compatible server at the configured baseUrl; only when nothing is
 * listening on a *loopback* address does it start one, under a per-address lock so concurrent
 * clients converge on a single instance. A started server is detached with no inherited stdio,
 * so it survives the client and is never killed by it, and is recorded (pid + log) in a
 * client-owned directory. A reachable-but-incompatible listener is never treated as absent.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError, BridgeHttpClient } from "./client.ts";
import { DEFAULT_SERVER_MODULE, isLoopback, serverEntrySpecifier, type BridgeSettings } from "./config.ts";

export interface EnsureResult { baseUrl: string; owned: boolean; pid: number | null }
export type ProbeResult = "ok" | "down" | "incompatible";

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

function logTail(path: string): string {
  try { return redact(readFileSync(path, "utf8").slice(-4000)).trim(); }
  catch { return ""; }
}

export class ServerLifecycle {
  private readonly dir: string;
  private readonly baseUrl: string;
  private readonly settings: BridgeSettings;
  private readonly baseCwd: string;
  private readonly probeClient: BridgeHttpClient;

  constructor(settings: BridgeSettings, env: NodeJS.ProcessEnv = process.env, baseCwd: string = process.cwd()) {
    this.settings = settings;
    this.baseUrl = settings.baseUrl;
    this.dir = clientDirectory(env);
    this.baseCwd = baseCwd;
    this.probeClient = new BridgeHttpClient({ ...settings, baseUrl: settings.baseUrl, requestTimeoutMs: PROBE_TIMEOUT_MS });
  }

  async probe(): Promise<ProbeResult> {
    try {
      const data = await this.probeClient.call("ping", {});
      return data.status === "ok" && data.protocol_version === 2 ? "ok" : "incompatible";
    } catch (error) {
      if (error instanceof BridgeError && error.code === "network_error") return "down";
      return "incompatible";
    }
  }

  private async probePid(): Promise<number | null> {
    try {
      const data = await this.probeClient.call("ping", {});
      return data.status === "ok" && data.protocol_version === 2 && typeof data.pid === "number" ? data.pid : null;
    } catch { return null; }
  }

  async ensure(): Promise<EnsureResult> {
    const state = await this.probe();
    if (state === "ok") return { baseUrl: this.baseUrl, owned: false, pid: null };
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
    return new BridgeError("incompatible_server", `a service at ${this.baseUrl} answered but is not a compatible harness-acp-bridge server (protocol 2)`);
  }

  private async startLocal(): Promise<EnsureResult> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const key = this.baseUrl.replace(/[^A-Za-z0-9]+/g, "_");
    const release = await this.acquireLock(join(this.dir, `start-${key}.lock`));
    try {
      // Another client may have started it while we waited for the lock; a foreign listener that
      // appeared meanwhile must likewise never be treated as absent.
      const state = await this.probe();
      if (state === "ok") return { baseUrl: this.baseUrl, owned: false, pid: null };
      if (state === "incompatible") throw this.incompatible();

      const logPath = join(this.dir, `server-${key}.log`);
      const entry = this.settings.serverEntry ?? DEFAULT_SERVER_MODULE;
      const specifier = serverEntrySpecifier(entry, this.baseCwd) ?? entry;
      const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_ACP_BRIDGE_SERVER_MODULE: specifier };
      if (this.settings.configPath) env.HARNESS_ACP_BRIDGE_CONFIG = this.settings.configPath;

      const fd = openSync(logPath, "a", 0o600);
      let child;
      try {
        child = spawn(process.execPath, [fileURLToPath(new URL("./bootstrap.mjs", import.meta.url))], {
          detached: true, stdio: ["ignore", fd, fd], env, cwd: this.dir,
        });
      } finally { closeSync(fd); }
      child.unref();
      const pid = child.pid ?? null;

      const deadline = Date.now() + this.settings.startupTimeoutMs;
      while (Date.now() < deadline) {
        const claimed = await this.claim(pid, logPath);
        if (claimed) return claimed;
        if (pid === null || !alive(pid)) break;
        await sleep(100);
      }
      // The final probe uses the same ownership check, so a child that only becomes ready at the
      // deadline is recorded as ours instead of being reclaimed.
      const claimed = await this.claim(pid, logPath);
      if (claimed) return claimed;
      this.reclaim(pid);
      const tail = logTail(logPath);
      throw new BridgeError("startup_failed", `could not start a harness-acp-bridge server at ${this.baseUrl} within ${this.settings.startupTimeoutMs}ms${tail ? `\nserver log: ${tail}` : ""}`);
    } finally {
      await release();
    }
  }

  /**
   * Resolve a probe into a result, or `null` to keep waiting. Ownership is claimed only when the
   * answering process is the child we started; a peer that won the race is reused and our own
   * (non-serving) child is reclaimed.
   */
  private async claim(pid: number | null, logPath: string): Promise<EnsureResult | null> {
    const state = await this.probe();
    if (state === "ok") {
      if (pid !== null && await this.probePid() === pid) {
        this.record(pid, logPath);
        return { baseUrl: this.baseUrl, owned: true, pid };
      }
      this.reclaim(pid);
      return { baseUrl: this.baseUrl, owned: false, pid: null };
    }
    if (state === "incompatible") { this.reclaim(pid); throw this.incompatible(); }
    return null;
  }

  /** Stop a child we started that did not become the answering server (best effort). */
  private reclaim(pid: number | null): void {
    if (pid === null) return;
    try { if (alive(pid)) process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }

  private record(pid: number | null, logPath: string): void {
    const file = join(this.dir, "servers.json");
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { data = {}; }
    data[this.baseUrl] = { pid, log: logPath, started_at: new Date().toISOString() };
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
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

export function readServerRegistry(dir = clientDirectory()): Record<string, { pid: number | null; log: string; started_at: string }> {
  const file = join(dir, "servers.json");
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, { pid: number | null; log: string; started_at: string }>; }
  catch { return {}; }
}
