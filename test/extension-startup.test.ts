import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { context } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
describe("startup error notices", () => {
  it("reports the missing entry and gives the correct reload/retry guidance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-acp-notice-"));
    dirs.push(dir);
    const entry = join(dir, "missing-cli.js");
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ command: process.execPath, args: [entry] }));
    vi.stubEnv("PI_ACP_BRIDGE_SETTINGS", path);
    vi.stubEnv("HARNESS_ACP_BRIDGE_SERVER", "");
    vi.stubEnv("HARNESS_ACP_BRIDGE_CONFIG", "");
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
    const ctx = context();
    const api = {
      registerTool: vi.fn(), registerCommand: vi.fn(),
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler),
    } as unknown as ExtensionAPI;
    extension(api);
    try {
      await handlers.get("session_start")!({}, ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(entry), "warning");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ENOENT"), "warning");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("If settings changed, /reload"), "warning");
    } finally { await handlers.get("session_shutdown")!({}, ctx); }
  });
});
