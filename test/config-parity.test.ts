/**
 * Cross-client settings parity (driven from the Pi package).
 *
 * Same matrix as `mcp/test/config-parity.test.ts`, but from the Pi side so a `pi-extension`
 * `check` run also fails on drift. It compares the real `loadSettings` (Pi, local) with the real
 * `readSettings` (MCP proxy, sibling repo) — either both reject a source or both resolve the same
 * final value for every shared key.
 *
 * The clients are independent git repositories, so the sibling is loaded **dynamically** and only
 * when present: a standalone `pi-extension/` checkout skips just this parity group instead of
 * failing test collection. Set `ACP_BRIDGE_PARITY_SIBLING` to the sibling `config.ts` path to
 * point elsewhere.
 *
 * The clients use different JSON key names for the per-request timeout (`requestTimeoutMs` vs
 * `timeoutMs`) and different default timeout values, so the two files are generated from one
 * Pi-keyed spec and the timeout is compared only when set explicitly.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.ts";

interface SharedResult { baseUrl: string; startupTimeoutMs: number; autoStart: boolean; serverEntry: string | null; configPath: string | null }
interface McpLike extends SharedResult { timeoutMs: number }

const here = dirname(fileURLToPath(import.meta.url));
const siblingPath = process.env.ACP_BRIDGE_PARITY_SIBLING ?? resolve(here, "../../mcp/src/config.ts");
let mcpReadSettings: ((env: NodeJS.ProcessEnv, cwd: string) => McpLike) | null = null;
if (existsSync(siblingPath)) {
  try {
    const sibling = await import(pathToFileURL(siblingPath).href) as { readSettings?: (env: NodeJS.ProcessEnv, cwd?: string) => McpLike };
    if (typeof sibling.readSettings === "function") mcpReadSettings = (env, cwd) => sibling.readSettings!(env, cwd);
  } catch { mcpReadSettings = null; }
}

const dirs: string[] = [];
function temp(prefix = "cfg-parity-"): string { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; }
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

/** Pi-keyed fields; the MCP file is the same with `requestTimeoutMs` renamed to `timeoutMs`. */
function mcpFileText(fields: Record<string, unknown>): string {
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) renamed[key === "requestTimeoutMs" ? "timeoutMs" : key] = value;
  return JSON.stringify(renamed);
}

interface Case {
  name: string;
  /** Pi-keyed fields written to both settings files. */
  fields?: Record<string, unknown>;
  /** A raw file body (bad JSON / non-object / unknown-key cases), used verbatim for both. */
  raw?: string;
  /** Shared environment variables applied to both clients. */
  env?: Record<string, string>;
  compareTimeout?: boolean;
}

const cases: Case[] = [
  { name: "defaults (timeouts differ by design)", env: {} },
  { name: "valid file only", compareTimeout: true, fields: { baseUrl: "http://127.0.0.1:9001", requestTimeoutMs: 5000, startupTimeoutMs: 6000, autoStart: false, serverEntry: "pkg", configPath: "c.yaml" } },
  { name: "env URL shadows an invalid file URL", fields: { baseUrl: "ftp://bad" }, env: { HARNESS_ACP_BRIDGE_URL: "http://127.0.0.1:9000" } },
  { name: "env TIMEOUT_MS shadows an invalid file timeout", compareTimeout: true, fields: { requestTimeoutMs: "nope" }, env: { HARNESS_ACP_BRIDGE_TIMEOUT_MS: "1500" } },
  { name: "env AUTOSTART shadows an invalid file autoStart", fields: { autoStart: "maybe" }, env: { HARNESS_ACP_BRIDGE_AUTOSTART: "0" } },
  { name: "env SERVER_ENTRY shadows an invalid file serverEntry", fields: { serverEntry: 5 }, env: { HARNESS_ACP_BRIDGE_SERVER_ENTRY: "pkg" } },
  { name: "env CONFIG shadows a file configPath", fields: { configPath: "file.yaml" }, env: { HARNESS_ACP_BRIDGE_CONFIG: "env.yaml" } },
  { name: "empty env CONFIG clears a file configPath", fields: { configPath: "file.yaml" }, env: { HARNESS_ACP_BRIDGE_CONFIG: "" } },
  { name: "empty env SERVER_ENTRY clears a file serverEntry", fields: { serverEntry: "pkg" }, env: { HARNESS_ACP_BRIDGE_SERVER_ENTRY: "" } },
  { name: "invalid file only (bad URL) fails both", fields: { baseUrl: "ftp://bad" } },
  { name: "non-string file serverEntry fails both", fields: { serverEntry: 5 } },
  { name: "zero file timeout fails both", fields: { requestTimeoutMs: 0 } },
  { name: "relative file configPath resolves against cwd", fields: { configPath: "sub/c.yaml" } },
  // JSON null is an invalid value for the shared numeric fields on *both* clients.
  { name: "null file timeout fails both", fields: { requestTimeoutMs: null } },
  { name: "null file startupTimeoutMs fails both", fields: { startupTimeoutMs: null } },
  { name: "valid env TIMEOUT_MS overrides a null file timeout", compareTimeout: true, fields: { requestTimeoutMs: null }, env: { HARNESS_ACP_BRIDGE_TIMEOUT_MS: "1500" } },
  { name: "valid env STARTUP_TIMEOUT_MS overrides a null file startup", fields: { startupTimeoutMs: null }, env: { HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS: "2500" } },
  // JSON null on the optional/enum fields defaults or clears identically on both clients.
  { name: "null file autoStart defaults true on both", fields: { autoStart: null } },
  { name: "null file baseUrl defaults on both", fields: { baseUrl: null } },
  { name: "null file serverEntry is null on both", fields: { serverEntry: null } },
  { name: "null file configPath is null on both", fields: { configPath: null } },
  { name: "unknown key fails both", raw: JSON.stringify({ command: "node" }) },
  { name: "bad JSON fails both", raw: "{not json" },
  { name: "non-object JSON fails both", raw: "[1,2,3]" },
];

function outcome<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  try { return { ok: true, value: fn() }; }
  catch { return { ok: false }; }
}

const parity: (name: string, fn: () => void) => void = mcpReadSettings ? describe : describe.skip;

parity("Pi loadSettings ⇄ MCP readSettings parity", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const cwd = temp();
      const agentDir = temp();
      const mcpEnv: NodeJS.ProcessEnv = {};
      const piEnv: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: agentDir };
      if (testCase.raw !== undefined) {
        const file = join(cwd, "shared.json");
        writeFileSync(file, testCase.raw);
        mcpEnv.HARNESS_ACP_BRIDGE_MCP_CONFIG = file;
        piEnv.PI_ACP_BRIDGE_SETTINGS = file;
      } else if (testCase.fields !== undefined) {
        const piFile = join(cwd, "pi.json");
        writeFileSync(piFile, JSON.stringify(testCase.fields));
        const mcpFile = join(cwd, "mcp.json");
        writeFileSync(mcpFile, mcpFileText(testCase.fields));
        mcpEnv.HARNESS_ACP_BRIDGE_MCP_CONFIG = mcpFile;
        piEnv.PI_ACP_BRIDGE_SETTINGS = piFile;
      }
      Object.assign(mcpEnv, testCase.env ?? {});
      Object.assign(piEnv, testCase.env ?? {});

      const mcp = outcome(() => mcpReadSettings!(mcpEnv, cwd));
      const pi = outcome(() => loadSettings(cwd, piEnv));
      expect(pi.ok, `expected both to ${mcp.ok ? "succeed" : "fail"}`).toBe(mcp.ok);
      if (mcp.ok && pi.ok) {
        expect({
          baseUrl: pi.value.baseUrl, startupTimeoutMs: pi.value.startupTimeoutMs, autoStart: pi.value.autoStart,
          serverEntry: pi.value.serverEntry, configPath: pi.value.configPath,
        }).toEqual({
          baseUrl: mcp.value.baseUrl, startupTimeoutMs: mcp.value.startupTimeoutMs, autoStart: mcp.value.autoStart,
          serverEntry: mcp.value.serverEntry, configPath: mcp.value.configPath,
        });
        if (testCase.compareTimeout) expect(pi.value.requestTimeoutMs).toBe(mcp.value.timeoutMs);
      }
    });
  }
});
