/**
 * Connection settings for the Pi bridge client.
 *
 * The client only *connects* to a harness-acp-bridge HTTP server, and may start a local one on
 * demand (see `lifecycle.ts`). It never accepts a command or argv pass-through: only the server
 * URL, timing, and a managed server entry/config belong here.
 */
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAskUserPolicy, type AskUserPolicy } from "./tool-trust.ts";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
export const DEFAULT_REQUEST_TIMEOUT_MS = 900_000;
export const DEFAULT_INTERACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_SERVER_MODULE = "@black942026/harness-acp-bridge-server";

export interface BridgeSettings {
  baseUrl: string;
  requestTimeoutMs: number;
  interactionTimeoutMs: number;
  pollIntervalMs: number;
  /** Start a local server when the configured one is unreachable (loopback only). */
  autoStart: boolean;
  /** Explicit server module/path, or null to resolve the installed server dependency. */
  serverEntry: string | null;
  /** Explicit server YAML config path, or null to honor HARNESS_ACP_BRIDGE_CONFIG/defaults. */
  configPath: string | null;
  startupTimeoutMs: number;
  /** Caller tool identity/provenance and the minimum compatible installed package version. */
  askUser: AskUserPolicy;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate an HTTP(S) base URL without a query, fragment, or embedded credentials. */
export function normalizeBaseUrl(value: string, source: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${source}: baseUrl is not a valid URL: ${JSON.stringify(value)}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${source}: baseUrl must use http or https`);
  }
  if (url.username || url.password) throw new Error(`${source}: baseUrl must not embed credentials`);
  if (url.search || url.hash) throw new Error(`${source}: baseUrl must not contain a query or fragment`);
  return url.toString().replace(/\/$/, "");
}

/** True when the URL points at the local machine, so starting a local server is safe. */
export function isLoopback(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Import specifier for an explicit server entry, resolved against `cwd`.
 *
 * A `file:` URL is returned unchanged (never re-wrapped in `pathToFileURL`); an absolute or
 * `./`/`../` path becomes a `file:` URL; a bare package name returns `null` (imported as-is).
 * The entry must export `HarnessHttpServer`/`loadConfig` (the server package index), not a CLI.
 */
export function serverEntrySpecifier(entry: string, cwd: string): string | null {
  if (entry.startsWith("file:")) return entry;
  if (isAbsolute(entry)) return pathToFileURL(entry).href;
  if (entry.startsWith("./") || entry.startsWith("../")) return pathToFileURL(resolve(cwd, entry)).href;
  return null;
}

/**
 * Locate an executable on `PATH`, resolved against the *client's* working directory.
 *
 * Every `PATH` entry is normalized first: an empty entry means the cwd (POSIX), and a relative
 * entry is resolved against `cwd` — never the supervisor's own cwd. A candidate must be an
 * executable *regular file*; a symlink is followed to its target (so a standard npm global `.bin`
 * shim resolves to the real module). Nonexistent entries, directories, and non-executable files
 * are skipped. Returns the real (symlink-resolved) path, or null.
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  if (env.PATH === undefined) return null;
  for (const raw of env.PATH.split(":")) {
    const dir = raw === "" ? cwd : isAbsolute(raw) ? raw : resolve(cwd, raw);
    let real: string;
    try { real = realpathSync(join(dir, name)); }
    catch { continue; }
    try {
      if (!statSync(real).isFile()) continue;
      accessSync(real, constants.X_OK);
    } catch { continue; }
    return real;
  }
  return null;
}

/**
 * How to launch a local server: an importable module (`dist/index.js`-style server package), or
 * the `hacpd` CLI found on `PATH`.
 *
 * Selection order (highest first): an explicit `serverEntry` (environment, then JSON) → `hacpd`
 * on `PATH` → the installed server dependency. An explicit entry is final: it is never silently
 * ignored, and a probe is never run behind it. The `hacpd` command is only ever the fixed PATH
 * lookup — no caller-supplied command/args/env is accepted.
 */
export type ServerLaunch = { kind: "module"; specifier: string } | { kind: "command"; command: string };

export function resolveServerLaunch(settings: Pick<BridgeSettings, "serverEntry">, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): ServerLaunch {
  if (settings.serverEntry !== null) {
    return { kind: "module", specifier: serverEntrySpecifier(settings.serverEntry, cwd) ?? settings.serverEntry };
  }
  const hacpd = findExecutable("hacpd", env, cwd);
  if (hacpd !== null) return { kind: "command", command: hacpd };
  return { kind: "module", specifier: DEFAULT_SERVER_MODULE };
}

const SETTING_KEYS = ["baseUrl", "requestTimeoutMs", "interactionTimeoutMs", "pollIntervalMs", "autoStart", "serverEntry", "configPath", "startupTimeoutMs", "askUser"] as const;

function positiveInteger(value: unknown, source: string, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) {
    throw new Error(`${source}: ${name} must be a positive integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, source: string): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  if (value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(`${source}: autoStart must be a boolean`);
}

/** `undefined`/`null`/`""` normalize to null (clearing an optional entry/path); a non-string throws. */
function stringOrNull(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

/**
 * Resolve settings from an explicit `PI_ACP_BRIDGE_SETTINGS` file, otherwise the global agent
 * directory then the project `.pi` directory (project overrides global).
 *
 * The resolution mirrors the MCP proxy exactly and in three phases, so the two clients share one
 * **input and precedence** semantics: (1) every JSON source is read and shape-checked — unknown
 * keys, a non-object document, and bad JSON are rejected, but values are not validated yet — and
 * merged global→project per key; (2) each final value is *selected* with `env ?? merged ??
 * default` (numeric timeouts use `env !== undefined`); (3) only the selected value is validated.
 * An invalid JSON value that a valid environment value shadows therefore never throws, matching
 * the MCP proxy. Pi-only keys (`interactionTimeoutMs`, `pollIntervalMs`) keep their own defaults
 * and have no shared environment variable.
 */
export function loadSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): BridgeSettings {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const paths = env.PI_ACP_BRIDGE_SETTINGS
    ? [resolve(cwd, env.PI_ACP_BRIDGE_SETTINGS)]
    : [join(agentDir, "harness-acp-bridge.json"), join(cwd, ".pi", "harness-acp-bridge.json")];

  const file: Record<string, unknown> = {};
  for (const path of paths) {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) {
      if (!env.PI_ACP_BRIDGE_SETTINGS && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let data: unknown;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${path}: invalid JSON (check the bridge settings file)`); }
    if (!isRecord(data)) throw new Error(`${path}: expected an object`);
    for (const key of Object.keys(data)) {
      if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new Error(`${path}: unknown setting ${key}`);
    }
    const previousAskUser = file.askUser;
    Object.assign(file, data);
    if (isRecord(previousAskUser) && isRecord(data.askUser)) file.askUser = { ...previousAskUser, ...data.askUser };
  }

  const rawBaseUrl = env.HARNESS_ACP_BRIDGE_URL ?? file.baseUrl ?? DEFAULT_BASE_URL;
  if (typeof rawBaseUrl !== "string" || !rawBaseUrl.trim()) throw new Error("baseUrl must be a non-empty string");
  const baseUrl = normalizeBaseUrl(rawBaseUrl.trim(), "settings");

  // Shared numeric timeouts mirror the MCP proxy exactly (`file.x !== undefined ? validate(x) :
  // default`), so a JSON `null` is *not* treated as "absent": it is an invalid value and rejected.
  const requestTimeoutMs = env.HARNESS_ACP_BRIDGE_TIMEOUT_MS !== undefined
    ? positiveInteger(Number(env.HARNESS_ACP_BRIDGE_TIMEOUT_MS), "environment", "HARNESS_ACP_BRIDGE_TIMEOUT_MS")
    : file.requestTimeoutMs !== undefined ? positiveInteger(file.requestTimeoutMs, "settings", "requestTimeoutMs") : DEFAULT_REQUEST_TIMEOUT_MS;

  const startupTimeoutMs = env.HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS !== undefined
    ? positiveInteger(Number(env.HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS), "environment", "HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS")
    : file.startupTimeoutMs !== undefined ? positiveInteger(file.startupTimeoutMs, "settings", "startupTimeoutMs") : DEFAULT_STARTUP_TIMEOUT_MS;

  const autoStart = booleanValue(env.HARNESS_ACP_BRIDGE_AUTOSTART ?? file.autoStart, "settings");

  const serverEntry = stringOrNull(env.HARNESS_ACP_BRIDGE_SERVER_ENTRY ?? file.serverEntry, "serverEntry");
  const rawConfigPath = stringOrNull(env.HARNESS_ACP_BRIDGE_CONFIG ?? file.configPath, "configPath");
  // The bootstrap runs with its own cwd, so resolve the server config against the original cwd.
  const configPath = rawConfigPath === null ? null : resolve(cwd, rawConfigPath);

  // Pi-only keys keep their own strict semantics: a JSON `null` is invalid, not "absent".
  const interactionTimeoutMs = file.interactionTimeoutMs !== undefined ? positiveInteger(file.interactionTimeoutMs, "settings", "interactionTimeoutMs") : DEFAULT_INTERACTION_TIMEOUT_MS;
  const pollIntervalMs = file.pollIntervalMs !== undefined ? positiveInteger(file.pollIntervalMs, "settings", "pollIntervalMs") : DEFAULT_POLL_INTERVAL_MS;

  const askUser = parseAskUserPolicy(file.askUser);
  return { baseUrl, requestTimeoutMs, interactionTimeoutMs, pollIntervalMs, autoStart, serverEntry, configPath, startupTimeoutMs, askUser };
}
