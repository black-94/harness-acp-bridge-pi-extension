/**
 * End-to-end Pi client tests: the extension starts a real harness-acp-bridge server (the
 * installed dependency) on demand and drives the server's fake ACP harness. Skips when the
 * server fixture is missing. No paid model, Docker, or SSH.
 */
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { context } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = process.env.ACP_BRIDGE_SERVER_DIR ? resolve(process.env.ACP_BRIDGE_SERVER_DIR) : resolve(here, "../../server");
const fakeHarness = join(serverDir, "test/fixtures/fake-acp-harness.mjs");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(r => server.close(() => r()));
  return port;
}

interface Host {
  execute: (name: string, args: unknown, signal?: AbortSignal, onUpdate?: (u: AgentToolResult<Record<string, unknown>>) => void) => Promise<AgentToolResult<Record<string, unknown>>>;
  ctx: ExtensionToolContext;
  shutdown: () => Promise<void>;
}

describe.runIf(existsSync(fakeHarness))("Pi client against a real server it starts on demand", () => {
  let dir: string;
  let clientDir: string;
  let baseUrl: string;
  let host: Host;
  let session: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-acp-e2e-"));
    clientDir = join(dir, "client");
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    writeFileSync(join(dir, "config.yaml"), JSON.stringify({
      schema_version: 2,
      paths: { state_dir: join(dir, "sessions") },
      server: { host: "127.0.0.1", port },
      sessions: { max_concurrency: 4, reap_interval_seconds: 1 },
      timeouts: { startup_timeout_seconds: 5, request_timeout_seconds: 2, turn_timeout_seconds: 8, turn_cancel_timeout_seconds: 0.5, terminate_grace_seconds: 0.1, remote_cleanup_timeout_seconds: 0.1, authentication_timeout_seconds: 1 },
      buffers: { preview_text_bytes: "8B" },
      authentication: { rate_limit: { enabled: false } },
      default_harness: "codebuddy",
      harnesses: { codebuddy: { command: process.execPath, args: [fakeHarness], models: [{ id: "fake-model", thinking_levels: ["low", "high"] }, { id: "fake-model-2" }] } },
    }));
    vi.stubEnv("HARNESS_ACP_BRIDGE_CLIENT_DIR", clientDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));

    const tools = new Map<string, ToolDefinition>();
    const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
    const api = {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, callback),
      appendEntry: vi.fn(), getActiveTools: () => [...tools.keys()], getAllTools: () => [...tools.values()],
      sendUserMessage: vi.fn(), sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "harness-acp-bridge.json"), JSON.stringify({
      baseUrl, autoStart: true, configPath: join(dir, "config.yaml"),
      pollIntervalMs: 20, interactionTimeoutMs: 5000, requestTimeoutMs: 15000, startupTimeoutMs: 20000,
    }));
    const ctx = context({ cwd: dir, hasUI: true });
    Object.assign(ctx, { sessionManager: { getBranch: () => [], getEntries: () => [] } });
    extension(api);
    await events.get("session_start")!({}, ctx);

    host = {
      ctx,
      execute: (name, args, signal, onUpdate) => tools.get(name)!.execute("call-1", args, signal, onUpdate as never, ctx) as Promise<AgentToolResult<Record<string, unknown>>>,
      shutdown: async () => { await events.get("session_shutdown")!({}, ctx); },
    };
  }, 40000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    try { const registry = JSON.parse(readFileSync(join(clientDir, "servers.json"), "utf8")) as Record<string, { pid: number | null }>; for (const entry of Object.values(registry)) if (entry.pid) { try { process.kill(entry.pid, "SIGTERM"); } catch { /* gone */ } } } catch { /* none */ }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("autostarts the server, then creates a session and synchronously completes a message", async () => {
    // session_start already started the local server on demand.
    expect(existsSync(join(clientDir, "servers.json"))).toBe(true);
    session = (await host.execute("acp_create_session", { cwd: dir, model_id: "fake-model" })).details!.session_id as string;
    const result = await host.execute("acp_send_message", { session_id: session, text: "hello 中文😀" });
    expect(result.details!.terminal).toBe(true);
    expect((result.details!.result as { text: string }).text).toBe("echo:hello 中文😀");
  });

  it("keeps the turn running until a permission popup is answered", async () => {
    vi.mocked(host.ctx.ui.select).mockResolvedValue("1. Allow once [allow_once]");
    const result = await host.execute("acp_send_message", { session_id: session, text: "permission" });
    expect(result.details!.terminal).toBe(true);
    expect((result.details!.result as { text: string }).text).toContain("[allowed:allow_once]");
    expect(host.ctx.ui.select).toHaveBeenCalled();
  });

  it("pages live output with cursors and joins UTF-8 fragments", async () => {
    const sent = await host.execute("acp_send_message", { session_id: session, text: "fragments😀" });
    const message = sent.details!.message_id as string;
    let cursor: string | undefined;
    let text = "";
    for (let page = 0; page < 100; page++) {
      const output = (await host.execute("acp_live_output", { session_id: session, message_id: message, limit: 2, ...(cursor ? { cursor } : {}) })).details as { events: Array<{ type: string; text: string }>; next_cursor: string; has_more: boolean };
      for (const event of output.events) if (event.type === "answer") text += event.text;
      cursor = output.next_cursor;
      if (!output.has_more) break;
    }
    expect(text).toBe("echo:fragments😀");
  });

  it("returns waiting_input without UI, answers explicitly, then clears the remote message", async () => {
    (host.ctx as { hasUI: boolean }).hasUI = false;
    const pending = await host.execute("acp_send_message", { session_id: session, text: "permission" });
    expect(pending.details!.state).toBe("waiting_input");
    const message = pending.details!.message_id as string;
    const question = (pending.details!.questions as Array<{ request_id: string }>)[0];
    await host.execute("acp_answer_question", { session_id: session, message_id: message, request_id: question.request_id, option_id: "allow_once" });
    const done = await host.execute("acp_wait", { session_id: session, message_id: message });
    expect(done.details!.terminal).toBe(true);

    const second = await host.execute("acp_send_message", { session_id: session, text: "permission" });
    const cancelled = await host.execute("acp_cancel_message", { session_id: session, message_id: second.details!.message_id });
    expect(cancelled.details!.state).toBe("cancelled");
    (host.ctx as { hasUI: boolean }).hasUI = true;
    await host.execute("acp_close_session", { session_id: session });
  });

  it("does not kill the reused server on shutdown", async () => {
    const registry = JSON.parse(readFileSync(join(clientDir, "servers.json"), "utf8")) as Record<string, { pid: number }>;
    const pid = Object.values(registry)[0]!.pid;
    await host.shutdown();
    const response = await fetch(`${baseUrl}/api/ping`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    expect((await response.json() as { ok: boolean }).ok).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });
});
