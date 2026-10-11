import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeSettings } from "../src/config.ts";
import { ServerLifecycle } from "../src/lifecycle.ts";

// A mocked spawn lets us fix the child pid so identity can be asserted deterministically.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const dirs: string[] = [];
beforeEach(() => { vi.mocked(spawn).mockReturnValue({ pid: 4242, unref: vi.fn(), exitCode: null } as never); });
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function settings(baseUrl: string, overrides: Partial<BridgeSettings> = {}): BridgeSettings {
  return { baseUrl, requestTimeoutMs: 15000, interactionTimeoutMs: 5000, pollIntervalMs: 200, autoStart: true, serverEntry: null, configPath: null, startupTimeoutMs: 1, ...overrides };
}

describe("startLocal final-probe ownership", () => {
  it("records a child that only becomes ready at the deadline probe instead of reclaiming it", async () => {
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
    vi.spyOn(lifecycle as unknown as { probePid(): Promise<number | null> }, "probePid").mockResolvedValue(4242);

    const result = await lifecycle.ensure();
    expect(result).toMatchObject({ owned: true, pid: 4242 });
    expect(JSON.parse(readFileSync(join(clientDir, "servers.json"), "utf8"))["http://127.0.0.1:1"].pid).toBe(4242);
    expect(kills).not.toContain(4242);
  });

  it("reuses a peer and reclaims only our own child when the pids differ", async () => {
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
    expect(result).toMatchObject({ owned: false, pid: null });
    expect(kills).toContain(4242);
    expect(kills).not.toContain(9999);
  });
});
