import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { createServer as createHttp, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerLifecycle, redact } from "../src/lifecycle.ts";
import type { BridgeSettings } from "../src/config.ts";
import { fakeHarness, newContractServerEntry, serverSpawningAvailable } from "./server-build.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(r => server.close(() => r()));
  return port;
}

function settings(baseUrl: string, overrides: Partial<BridgeSettings> = {}): BridgeSettings {
  return { baseUrl, requestTimeoutMs: 15000, interactionTimeoutMs: 5000, pollIntervalMs: 200, autoStart: true, serverEntry: newContractServerEntry(), configPath: null, startupTimeoutMs: 15000, ...overrides };
}

function registry(dir: string): Record<string, { pid: number | null }> {
  try { return JSON.parse(readFileSync(join(dir, "servers.json"), "utf8")); } catch { return {}; }
}

describe("diagnostics redaction", () => {
  it("masks credentials and control sequences", () => {
    const output = redact("token=SECRETVALUE\x1b[31m api_key abcdef123456", { API_KEY: "abcdef123456" });
    expect(output).not.toContain("SECRETVALUE");
    expect(output).not.toContain("abcdef123456");
    expect(output).not.toContain("\x1b");
  });
});

describe("managed local server lifecycle", () => {
  it.runIf(serverSpawningAvailable())("starts a loopback server on demand and reuses it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-life-"));
    const clientDir = join(dir, "client");
    const port = await freePort();
    const config = join(dir, "config.yaml");
    writeFileSync(config, JSON.stringify({
      schema_version: 2, paths: { state_dir: join(dir, "sessions") }, server: { host: "127.0.0.1", port },
      sessions: { max_concurrency: 4, reap_interval_seconds: 1 },
      timeouts: { startup_timeout_seconds: 5, request_timeout_seconds: 2, turn_timeout_seconds: 8, turn_cancel_timeout_seconds: 0.5, terminate_grace_seconds: 0.1, remote_cleanup_timeout_seconds: 0.1, authentication_timeout_seconds: 1 },
      authentication: { rate_limit: { enabled: false } }, default_harness: "codebuddy",
      harnesses: { codebuddy: { command: process.execPath, args: [fakeHarness], models: [{ id: "fake-model" }] } },
    }));
    cleanups.push(() => { for (const entry of Object.values(registry(clientDir))) if (entry.pid) { try { process.kill(entry.pid, "SIGTERM"); } catch { /* gone */ } } rmSync(dir, { recursive: true, force: true }); });
    const env = { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    const baseUrl = `http://127.0.0.1:${port}`;
    const first = new ServerLifecycle(settings(baseUrl, { configPath: config }), env);
    expect(await first.probe()).toBe("down");
    expect(await first.ensure()).toMatchObject({ owned: true });
    expect(await new ServerLifecycle(settings(baseUrl, { configPath: config }), env).ensure()).toMatchObject({ owned: false });
    expect(Object.keys(registry(clientDir))).toEqual([baseUrl]);
  });

  it("refuses to start for a non-loopback address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-life-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const clientDir = join(dir, "client");
    const lifecycle = new ServerLifecycle(settings("http://harness-acp-bridge.invalid:8787"), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    await expect(lifecycle.ensure()).rejects.toThrow(/refusing to start a local server/);
    expect(registry(clientDir)).toEqual({});
  });

  it("never starts behind an incompatible listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-life-"));
    const port = await freePort();
    const listener: Server = createHttp((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, data: { status: "ok", protocol_version: 1 } })); });
    await new Promise<void>(r => listener.listen(port, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>(r => listener.close(() => r())));
    const clientDir = join(dir, "client");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const lifecycle = new ServerLifecycle(settings(`http://127.0.0.1:${port}`), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    expect(await lifecycle.probe()).toBe("incompatible");
    await expect(lifecycle.ensure()).rejects.toMatchObject({ code: "incompatible_server" });
    expect(registry(clientDir)).toEqual({});
  });

  it("rejects an older-protocol daemon without restarting or killing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-life-"));
    const port = await freePort();
    // A still-running protocol-2 daemon must be rejected, never replaced.
    const listener: Server = createHttp((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, data: { status: "ok", protocol_version: 2, pid: process.pid } })); });
    await new Promise<void>(r => listener.listen(port, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>(r => listener.close(() => r())));
    const clientDir = join(dir, "client");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const lifecycle = new ServerLifecycle(settings(`http://127.0.0.1:${port}`), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    expect(await lifecycle.probe()).toBe("incompatible");
    await expect(lifecycle.ensure()).rejects.toMatchObject({ code: "incompatible_server" });
    // Nothing was started or recorded...
    expect(registry(clientDir)).toEqual({});
    // ...and the old daemon is still serving (it was not torn down).
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await response.json() as { ok: boolean }).ok).toBe(true);
  });
});
