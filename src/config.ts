/**
 * Connection settings for the Pi bridge client.
 *
 * The client only *connects* to a harness-acp-bridge HTTP server, and may start a local one on
 * demand (see `lifecycle.ts`). It never accepts a command or argv pass-through: only the server
 * URL, timing, and a managed server entry/config belong here.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

const TIMING_KEYS = { requestTimeoutMs: "requestTimeoutMs", interactionTimeoutMs: "interactionTimeoutMs", pollIntervalMs: "pollIntervalMs", startupTimeoutMs: "startupTimeoutMs" } as const;
const SETTING_KEYS = ["baseUrl", "requestTimeoutMs", "interactionTimeoutMs", "pollIntervalMs", "autoStart", "serverEntry", "configPath", "startupTimeoutMs"] as const;

function positiveInteger(value: unknown, source: string, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) {
    throw new Error(`${source}: invalid ${name}`);
  }
  return value as number;
}

function booleanValue(value: unknown, source: string): boolean {
  if (typeof value === "boolean") return value;
  if (value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(`${source}: invalid autoStart`);
}

/**
 * Resolve settings from an explicit `PI_ACP_BRIDGE_SETTINGS` file, otherwise the global agent
 * directory then the project `.pi` directory (project overrides global). Unknown fields are
 * rejected instead of ignored.
 */
export function loadSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): BridgeSettings {
  const settings: BridgeSettings = {
    baseUrl: DEFAULT_BASE_URL,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    interactionTimeoutMs: DEFAULT_INTERACTION_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    autoStart: true,
    serverEntry: null,
    configPath: null,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  };
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const paths = env.PI_ACP_BRIDGE_SETTINGS
    ? [resolve(cwd, env.PI_ACP_BRIDGE_SETTINGS)]
    : [join(agentDir, "harness-acp-bridge.json"), join(cwd, ".pi", "harness-acp-bridge.json")];
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
    for (const [key, value] of Object.entries(data)) {
      if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new Error(`${path}: unknown setting ${key}`);
      if (key === "baseUrl") {
        if (typeof value !== "string" || !value.trim()) throw new Error(`${path}: invalid baseUrl`);
        settings.baseUrl = normalizeBaseUrl(value.trim(), path);
      } else if (key === "autoStart") {
        settings.autoStart = booleanValue(value, path);
      } else if (key === "serverEntry") {
        if (value !== null && typeof value !== "string") throw new Error(`${path}: invalid serverEntry`);
        settings.serverEntry = (value as string | null) || null;
      } else if (key === "configPath") {
        if (value !== null && typeof value !== "string") throw new Error(`${path}: invalid configPath`);
        settings.configPath = (value as string | null) || null;
      } else {
        settings[TIMING_KEYS[key as keyof typeof TIMING_KEYS]] = positiveInteger(value, path, key);
      }
    }
  }
  // The server's own config env var stays honored unless the extension sets one explicitly.
  if (settings.configPath) settings.configPath = resolve(cwd, settings.configPath);
  else if (env.HARNESS_ACP_BRIDGE_CONFIG) settings.configPath = resolve(cwd, env.HARNESS_ACP_BRIDGE_CONFIG);
  return settings;
}
