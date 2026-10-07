import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface BridgeSettings {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  interactionTimeoutMs: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function loadSettings(cwd: string, env = process.env): BridgeSettings {
  const settings: BridgeSettings = {
    command: process.execPath, args: [], env: {}, cwd,
    pollIntervalMs: 500, requestTimeoutMs: 900_000, interactionTimeoutMs: 60_000,
  };
  let customCommand = false;
  // Preserve runtime/socket resolution and SSH/Docker connectivity, not arbitrary secrets.
  for (const key of ["XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "TMPDIR", "SSH_AUTH_SOCK", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    if (env[key] !== undefined) settings.env[key] = env[key]!;
  }
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
      if (key === "command" || key === "cwd") {
        if (typeof value !== "string" || !value.trim()) throw new Error(`${path}: invalid ${key}`);
        settings[key] = key === "cwd" && !isAbsolute(value) ? resolve(cwd, value) : value;
        if (key === "command") customCommand = true;
      } else if (key === "args") {
        if (!Array.isArray(value) || !value.every(v => typeof v === "string")) throw new Error(`${path}: args must be strings`);
        settings.args = value;
      } else if (key === "env") {
        if (!isRecord(value) || !Object.values(value).every(v => typeof v === "string")) throw new Error(`${path}: env must contain strings`);
        settings.env = { ...settings.env, ...value as Record<string, string> };
      } else if (key === "pollIntervalMs" || key === "requestTimeoutMs" || key === "interactionTimeoutMs") {
        if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) throw new Error(`${path}: invalid ${key}`);
        settings[key] = value as number;
      } else throw new Error(`${path}: unknown setting ${key}`);
    }
  }
  if (env.HARNESS_ACP_BRIDGE_SERVER) {
    settings.command = process.execPath;
    settings.args = [resolve(cwd, env.HARNESS_ACP_BRIDGE_SERVER)];
  } else if (!customCommand) {
    // Resolve from this extension, not the user's cwd or PATH: dependency bins
    // are not necessarily on PATH when Pi loads an installed npm package.
    let cli: string;
    try { cli = createRequire(import.meta.url).resolve("@black942026/harness-acp-bridge-server/dist/cli.js"); }
    catch {
      throw new Error("ACP bridge server dependency entry is unavailable: @black942026/harness-acp-bridge-server/dist/cli.js. Reinstall the extension or configure HARNESS_ACP_BRIDGE_SERVER with an existing built CLI path.");
    }
    settings.args = [cli, ...settings.args];
  }
  if (env.HARNESS_ACP_BRIDGE_CONFIG) {
    settings.env.HARNESS_ACP_BRIDGE_CONFIG = resolve(cwd, env.HARNESS_ACP_BRIDGE_CONFIG);
  }
  return settings;
}
