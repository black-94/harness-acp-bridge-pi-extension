import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { createServer as createHttp, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ServerLifecycle, redact } from "../src/lifecycle.ts";
import type { BridgeSettings } from "../src/config.ts";
import { defaultAskUserPolicy } from "../src/tool-trust.ts";
import { newContractServerCli, newContractServerEntry, serverSpawningAvailable } from "./server-build.ts";

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
  return { baseUrl, requestTimeoutMs: 15000, interactionTimeoutMs: 5000, pollIntervalMs: 200, autoStart: true, serverEntry: newContractServerEntry(), configPath: null, startupTimeoutMs: 15000, askUser: defaultAskUserPolicy(), ...overrides };
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
      harnesses: { codebuddy: { models: [{ id: "fake-model" }] } },
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

  it("refuses a still-running protocol-3 daemon without restarting or killing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-life-"));
    const port = await freePort();
    // The previous public contract: an occupied listener on protocol 3 must be refused, never
    // taken over, restarted, or killed by the client.
    const listener: Server = createHttp((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, data: { status: "ok", protocol_version: 3, pid: process.pid } })); });
    await new Promise<void>(r => listener.listen(port, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>(r => listener.close(() => r())));
    const clientDir = join(dir, "client");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const lifecycle = new ServerLifecycle(settings(`http://127.0.0.1:${port}`), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    expect(await lifecycle.probe()).toBe("incompatible");
    await expect(lifecycle.ensure()).rejects.toMatchObject({ code: "incompatible_server" });
    expect(registry(clientDir)).toEqual({});
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await response.json() as { ok: boolean }).ok).toBe(true);
  });

  it.runIf(serverSpawningAvailable())("does not run an inherited SERVER_COMMAND when an explicit module entry is selected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-life-"));
    const clientDir = join(dir, "client");
    const port = await freePort();
    const config = join(dir, "config.yaml");
    writeFileSync(config, JSON.stringify({
      schema_version: 2, paths: { state_dir: join(dir, "sessions") }, server: { host: "127.0.0.1", port },
      sessions: { max_concurrency: 4, reap_interval_seconds: 1 },
      timeouts: { startup_timeout_seconds: 5, request_timeout_seconds: 2, turn_timeout_seconds: 8, turn_cancel_timeout_seconds: 0.5, terminate_grace_seconds: 0.1, remote_cleanup_timeout_seconds: 0.1, authentication_timeout_seconds: 1 },
      authentication: { rate_limit: { enabled: false } }, default_harness: "codebuddy",
      harnesses: { codebuddy: { models: [{ id: "fake-model" }] } },
    }));
    const marker = join(dir, "hijack.marker");
    const evil = join(dir, "evil-command.cjs");
    writeFileSync(evil, `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    chmodSync(evil, 0o755);
    cleanups.push(() => { for (const entry of Object.values(registry(clientDir))) if (entry.pid) { try { process.kill(entry.pid, "SIGTERM"); } catch { /* gone */ } } rmSync(dir, { recursive: true, force: true }); });
    const env = { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir, HARNESS_ACP_BRIDGE_SERVER_COMMAND: evil };

    // `settings()` defaults to an explicit module entry, so the injected command must be cleared.
    expect(await new ServerLifecycle(settings(`http://127.0.0.1:${port}`, { configPath: config }), env).ensure()).toMatchObject({ owned: true });
    expect(existsSync(marker)).toBe(false);
  });
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function waitDead(pid: number, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!alive(pid)) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
  return !alive(pid);
}

describe.runIf(serverSpawningAvailable() && newContractServerCli() !== null)("managed local server via a PATH hacpd CLI", () => {
  function configFor(dir: string, port: number): string {
    const config = join(dir, "config.yaml");
    writeFileSync(config, JSON.stringify({
      schema_version: 2, paths: { state_dir: join(dir, "sessions") }, server: { host: "127.0.0.1", port },
      sessions: { max_concurrency: 4, reap_interval_seconds: 1 },
      timeouts: { startup_timeout_seconds: 5, request_timeout_seconds: 2, turn_timeout_seconds: 8, turn_cancel_timeout_seconds: 0.5, terminate_grace_seconds: 0.1, remote_cleanup_timeout_seconds: 0.1, authentication_timeout_seconds: 1 },
      authentication: { rate_limit: { enabled: false } }, default_harness: "codebuddy",
      harnesses: { codebuddy: { models: [{ id: "fake-model" }] } },
    }));
    return config;
  }
  function cli(dir: string, source: string): NodeJS.ProcessEnv {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    if (source === "symlink") {
      // Emulate an npm global bin: an *executable* Node script (the repo's dist/main.js is not
      // chmod +x) reached through a symlink, whose realpath is followed and whose shebang lets the
      // supervisor run it under `node --import <watchdog>`. The shim runs the real CLI in-process.
      const shim = join(dir, "hacpd-shim.mjs");
      writeFileSync(shim, `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(newContractServerCli()!).href)});\n`, { mode: 0o755 });
      symlinkSync(shim, join(bin, "hacpd"));
    } else {
      writeFileSync(join(bin, "hacpd"), source, { mode: 0o755 });
    }
    return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  }
  function kill(clientDir: string): void {
    for (const entry of Object.values(registry(clientDir))) if (entry.pid) { try { process.kill(entry.pid, "SIGTERM"); } catch { /* gone */ } }
  }
  function serverRecord(clientDir: string, baseUrl: string): { pid: number; logger_pid: number } {
    return registry(clientDir)[baseUrl] as unknown as { pid: number; logger_pid: number };
  }

  it("starts the real hacpd CLI, proves exact pid ownership, and reuses it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-cli-"));
    const clientDir = join(dir, "client");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = { ...cli(dir, "symlink"), HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    cleanups.push(() => { kill(clientDir); rmSync(dir, { recursive: true, force: true }); });

    const started = await new ServerLifecycle(settings(baseUrl, { serverEntry: null, configPath: config }), env).ensure();
    expect(started).toMatchObject({ owned: true, baseUrl });
    expect(started.pid).toBeGreaterThan(0);
    expect(registry(clientDir)[baseUrl].pid).toBe(started.pid);
    expect(await new ServerLifecycle(settings(baseUrl, { serverEntry: null, configPath: config }), env).ensure()).toMatchObject({ owned: false });
  });

  it("converges concurrent command-mode starts on one instance (peer race)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-cli-"));
    const clientDir = join(dir, "client");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = { ...cli(dir, "symlink"), HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    cleanups.push(() => { kill(clientDir); rmSync(dir, { recursive: true, force: true }); });

    const results = await Promise.all([
      new ServerLifecycle(settings(baseUrl, { serverEntry: null, configPath: config }), env).ensure(),
      new ServerLifecycle(settings(baseUrl, { serverEntry: null, configPath: config }), env).ensure(),
    ]);
    expect(results.filter(result => result.owned)).toHaveLength(1);
    expect(Object.keys(registry(clientDir))).toEqual([baseUrl]);
  });

  it("does not orphan the CLI when the supervisor is SIGKILLed (stdin-EOF watchdog)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-cli-"));
    const clientDir = join(dir, "client");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = { ...cli(dir, "symlink"), HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    cleanups.push(() => { kill(clientDir); rmSync(dir, { recursive: true, force: true }); });

    const started = await new ServerLifecycle(settings(baseUrl, { serverEntry: null, configPath: config }), env).ensure();
    const record = registry(clientDir)[baseUrl];
    expect(record.pid).toBe(started.pid);
    expect(alive(record.pid!)).toBe(true);
    process.kill((record as unknown as { logger_pid: number }).logger_pid, "SIGKILL");
    expect(await waitDead(record.pid!)).toBe(true);
  });

  it("refuses a non-Node hacpd wrapper with startup_failed and never runs it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-cli-"));
    const clientDir = join(dir, "client");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = { ...cli(dir, "#!/bin/sh\nexit 0\n"), HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    cleanups.push(() => { kill(clientDir); rmSync(dir, { recursive: true, force: true }); });

    let error: unknown;
    try { await new ServerLifecycle(settings(baseUrl, { serverEntry: null, configPath: config }), env).ensure(); }
    catch (cause) { error = cause; }
    expect((error as { code?: string }).code).toBe("startup_failed");
    expect(String(error)).toMatch(/Node script|supported server command/);
    expect(registry(clientDir)).toEqual({});
  });

  it("hard-fails (no fallback) when a Node hacpd is found but never serves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-cli-"));
    const clientDir = join(dir, "client");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = { ...cli(dir, "#!/usr/bin/env node\nprocess.exit(1)\n"), HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    cleanups.push(() => { kill(clientDir); rmSync(dir, { recursive: true, force: true }); });

    let error: unknown;
    try { await new ServerLifecycle(settings(baseUrl, { serverEntry: null, configPath: config, startupTimeoutMs: 3000 }), env).ensure(); }
    catch (cause) { error = cause; }
    expect((error as { code?: string }).code).toBe("startup_failed");
    expect(registry(clientDir)).toEqual({});
  });

  it("stops the CLI server and its supervisor when the server is SIGTERMed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-cli-"));
    const clientDir = join(dir, "client");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = { ...cli(dir, "symlink"), HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    cleanups.push(() => { kill(clientDir); rmSync(dir, { recursive: true, force: true }); });

    await new ServerLifecycle(settings(baseUrl, { serverEntry: null, configPath: config }), env).ensure();
    const record = serverRecord(clientDir, baseUrl);
    process.kill(record.pid, "SIGTERM");
    expect(await waitDead(record.pid)).toBe(true);
    expect(await waitDead(record.logger_pid)).toBe(true);
  });

  it("stops the CLI server too when the supervisor is SIGTERMed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-cli-"));
    const clientDir = join(dir, "client");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = { ...cli(dir, "symlink"), HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    cleanups.push(() => { kill(clientDir); rmSync(dir, { recursive: true, force: true }); });

    await new ServerLifecycle(settings(baseUrl, { serverEntry: null, configPath: config }), env).ensure();
    const record = serverRecord(clientDir, baseUrl);
    process.kill(record.logger_pid, "SIGTERM");
    expect(await waitDead(record.logger_pid)).toBe(true);
    expect(await waitDead(record.pid)).toBe(true);
  });

  it("does not import an inherited SERVER_MODULE when hacpd is selected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-cli-"));
    const clientDir = join(dir, "client");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const marker = join(dir, "hijack.marker");
    const evilModule = join(dir, "evil-module.mjs");
    writeFileSync(evilModule, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`);
    // Command mode is selected (PATH hacpd); the injected module entry must be cleared, not imported.
    const env = { ...cli(dir, "symlink"), HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir, HARNESS_ACP_BRIDGE_SERVER_MODULE: evilModule };
    cleanups.push(() => { kill(clientDir); rmSync(dir, { recursive: true, force: true }); });

    expect(await new ServerLifecycle(settings(baseUrl, { serverEntry: null, configPath: config }), env).ensure()).toMatchObject({ owned: true });
    expect(existsSync(marker)).toBe(false);
  });
});
