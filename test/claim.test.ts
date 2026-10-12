import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeSettings } from "../src/config.ts";
import { defaultAskUserPolicy } from "../src/tool-trust.ts";
import { ServerLifecycle } from "../src/lifecycle.ts";

/**
 * A mocked spawn fixes the supervisor pid and writes the proof file the real supervisor would,
 * so the launcher-proof ownership check can be asserted deterministically: only a proof signed
 * with *our* nonce whose `server_pid` matches the answering ping pid claims ownership.
 */
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const LAUNCHER_PID = 4242;
const SERVER_PID = 5555;
const dirs: string[] = [];

beforeEach(() => {
  vi.mocked(spawn).mockImplementation((_command, _args, options) => {
    const env = (options as { env: NodeJS.ProcessEnv }).env;
    writeFileSync(env.HARNESS_ACP_BRIDGE_PROOF!, JSON.stringify({ nonce: env.HARNESS_ACP_BRIDGE_NONCE, launcher_pid: LAUNCHER_PID, server_pid: SERVER_PID }));
    return { pid: LAUNCHER_PID, unref: vi.fn(), on: vi.fn() } as never;
  });
});
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function settings(baseUrl: string, overrides: Partial<BridgeSettings> = {}): BridgeSettings {
  return { baseUrl, requestTimeoutMs: 15000, interactionTimeoutMs: 5000, pollIntervalMs: 200, autoStart: true, serverEntry: null, configPath: null, startupTimeoutMs: 1, askUser: defaultAskUserPolicy(), ...overrides };
}

describe("startLocal launcher-proof ownership", () => {
  it("claims ownership only when the answering ping pid matches the nonce-signed proof", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-claim-"));
    dirs.push(dir);
    const clientDir = join(dir, "client");
    const kills: number[] = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0) kills.push(pid);
      return true;
    }) as never);
    const lifecycle = new ServerLifecycle(settings("http://127.0.0.1:1"), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    vi.spyOn(lifecycle, "probe").mockResolvedValueOnce("down").mockResolvedValueOnce("down").mockResolvedValueOnce("down").mockResolvedValueOnce("ok");
    vi.spyOn(lifecycle as unknown as { probePid(): Promise<number | null> }, "probePid").mockResolvedValue(SERVER_PID);

    const result = await lifecycle.ensure();
    expect(result).toMatchObject({ owned: true, pid: SERVER_PID, loggerPid: LAUNCHER_PID });
    const recorded = JSON.parse(readFileSync(join(clientDir, "servers.json"), "utf8"))["http://127.0.0.1:1"];
    expect(recorded.pid).toBe(SERVER_PID);
    expect(recorded.logger_pid).toBe(LAUNCHER_PID);
    expect(kills).not.toContain(LAUNCHER_PID);
    expect(kills).not.toContain(SERVER_PID);
  });

  it("reuses a peer and reclaims only our own supervisor+server when the pids differ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-claim-"));
    dirs.push(dir);
    const clientDir = join(dir, "client");
    const kills: number[] = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0) kills.push(pid);
      return true;
    }) as never);
    const lifecycle = new ServerLifecycle(settings("http://127.0.0.1:1"), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    vi.spyOn(lifecycle, "probe").mockResolvedValueOnce("down").mockResolvedValueOnce("down").mockResolvedValueOnce("ok");
    vi.spyOn(lifecycle as unknown as { probePid(): Promise<number | null> }, "probePid").mockResolvedValue(9999);

    const result = await lifecycle.ensure();
    expect(result).toMatchObject({ owned: false, pid: null, loggerPid: null });
    expect(kills).toContain(LAUNCHER_PID);
    expect(kills).toContain(SERVER_PID);
    expect(kills).not.toContain(9999);
  });
});
