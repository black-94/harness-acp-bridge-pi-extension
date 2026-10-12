/**
 * Regression coverage for the reported `Cannot read properties of undefined (reading 'length')`
 * progress failure.
 *
 * IMPORTANT: this is an *error-injection compatibility* test. It reproduces the exact TypeError a
 * naive partial-result consumer hits, and asserts the shipped partial result satisfies that
 * consumer's contract. It does NOT reproduce the original field stack — the prior worker could not
 * reproduce the original site even with the real Pi SDK and renderer — so it must not be read as
 * proof of the original root cause.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { MessageMonitor } from "../src/monitor.ts";
import { InteractionRouter } from "../src/interactions.ts";
import type { BridgeConnection } from "../src/client.ts";
import { context } from "./helpers.ts";

const SENTINEL = "PREVIEW-SENTINEL-DO-NOT-ENTER-CONTEXT";
// A real-length message id (`msg_` + 32 hex) so a renderer test cannot be fooled by a short stub.
const MESSAGE_ID = `msg_${"a".repeat(32)}`;
const ACTIVITY = { observed_phase: "tool_use", seconds_since_progress: 12, last_progress_at: "2026-01-01T00:00:00.000Z", stalled: true, stall_hint_seconds: 5 };

/**
 * Mirrors the naive host/third-party consumer behind the report:
 *   `partialResult.content[0].text.length`
 *   `JSON.stringify(partialResult.structuredContent).length`
 * Both indexes must exist for these readers; a missing `structuredContent` throws
 * "reading 'length'" and empty `content` throws "reading 'text'".
 */
function strictConsumer(partial: { content?: unknown; structuredContent?: unknown }): number {
  const textLength = (partial.content as Array<{ text: string }>)[0].text.length;
  const structuredLength = (JSON.stringify(partial.structuredContent) as string).length;
  return textLength + structuredLength;
}

describe("partial-result contract (error-injection compatibility)", () => {
  it("reproduces the reported TypeError on the legacy shape and passes on the shipped shape", () => {
    // Legacy: missing structuredContent reproduces the exact reported message.
    const legacyMissingStructured = { content: [{ type: "text", text: "x" }] };
    expect(() => strictConsumer(legacyMissingStructured)).toThrow(TypeError);
    expect(() => strictConsumer(legacyMissingStructured)).toThrow(/reading 'length'/);

    // Legacy: empty content breaks consumers that index content[0].
    expect(() => strictConsumer({ content: [], structuredContent: {} })).toThrow(TypeError);

    // Shipped contract: one empty text block plus an empty structured object satisfies both.
    expect(strictConsumer({ content: [{ type: "text", text: "" }], structuredContent: {} })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Real extension path over a stub HTTP server.
// ---------------------------------------------------------------------------

interface StubState { answered: boolean; sendCalls: number; polls: number }

function stubServer(mode: "interactive" | "running" = "interactive") {
  const state: StubState = { answered: false, sendCalls: 0, polls: 0 };
  const question = { request_id: "req-1", kind: "permission", title: "Run bash", message: "Allow command?", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }], schema: null };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const method = (request.url ?? "").replace(/^\/api\//, "");
      const params = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (method === "message_status") {
        response.writeHead(200, { "content-type": "application/json" });
        if (mode === "running") {
          // A running message with real activity for a few polls, then a terminal result.
          const done = ++state.polls >= 3;
          response.end(JSON.stringify({ ok: true, data: done
            ? { session_id: "s1", message_id: MESSAGE_ID, state: "completed", terminal: true, questions: [], result: { text: "final:hello" }, activity: { ...ACTIVITY, stalled: false } }
            : { session_id: "s1", message_id: MESSAGE_ID, state: "running", terminal: false, questions: [], progress: { text: SENTINEL }, activity: ACTIVITY } }));
          return;
        }
        response.end(JSON.stringify(state.answered
          ? { ok: true, data: { session_id: "s1", message_id: MESSAGE_ID, state: "completed", terminal: true, questions: [], result: { text: "final:hello" }, activity: { ...ACTIVITY, stalled: false } } }
          : { ok: true, data: { session_id: "s1", message_id: MESSAGE_ID, state: "waiting_input", terminal: false, questions: [question], progress: { text: SENTINEL }, activity: ACTIVITY } }));
        return;
      }
      if (method === "answer_question") {
        state.answered = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, data: { answered: true } }));
        return;
      }
      if (method === "send_message") state.sendCalls++;
      const bodies: Record<string, unknown> = {
        ping: { ok: true, data: { status: "ok", protocol_version: 4, sessions: 0 } },
        send_message: { ok: true, data: { message_id: MESSAGE_ID } },
        cancel_message: { ok: true, data: { state: "cancelled", terminal: true } },
        close_session: { ok: true, data: { session_id: params.session_id, state: "closed" } },
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(bodies[method] ?? { ok: false, error: { code: "unsupported_request", message: method } }));
    });
  });
  return { server, state };
}

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(hasUI = true, mode: "interactive" | "running" = "interactive") {
  const { server, state } = stubServer(mode);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), "pi-acp-progress-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi", "harness-acp-bridge.json"), JSON.stringify({ baseUrl, autoStart: false, pollIntervalMs: 5, interactionTimeoutMs: 5000, requestTimeoutMs: 5000 }));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
  vi.stubEnv("PI_ACP_BRIDGE_SETTINGS", "");
  vi.stubEnv("HARNESS_ACP_BRIDGE_CONFIG", "");

  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const api = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: () => {}, on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, callback),
    appendEntry: vi.fn(), getActiveTools: () => [...tools.keys()], getAllTools: () => [...tools.values()],
    sendUserMessage: vi.fn(), sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = context({ cwd: dir, hasUI });
  Object.assign(ctx, { sessionManager: { getBranch: () => [], getEntries: () => [] } });
  extension(api);
  await events.get("session_start")!({}, ctx);
  const execute = (name: string, args: unknown, signal?: AbortSignal, onUpdate?: (result: AgentToolResult<Record<string, unknown>>) => void) =>
    tools.get(name)!.execute("call-1", args, signal, onUpdate as never, ctx as ExtensionToolContext) as Promise<AgentToolResult<Record<string, unknown>>>;
  return { ctx, state, tools, execute, async cleanup() { await events.get("session_shutdown")!({}, ctx); } };
}

describe("progress updates through the real tool path", () => {
  it("sends a contract-shaped, preview-free partial update that the strict consumer accepts", async () => {
    const host = await setup(true);
    try {
      vi.mocked(host.ctx.ui.select).mockResolvedValue("1. Allow [allow_once]");
      const updates: AgentToolResult<Record<string, unknown>>[] = [];
      const result = await host.execute("acp_send_message", { session_id: "s1", text: "hello" }, undefined, update => updates.push(update));
      expect((result.details as { terminal: boolean }).terminal).toBe(true);
      const previewUpdate = updates.find(update => JSON.stringify(update.details ?? {}).includes(SENTINEL))!;
      expect(previewUpdate).toBeDefined();
      expect(() => strictConsumer(previewUpdate)).not.toThrow();
      expect(strictConsumer(previewUpdate)).toBeGreaterThan(0);
      expect(JSON.stringify(previewUpdate.content)).not.toContain(SENTINEL);
      expect(JSON.stringify(previewUpdate.structuredContent)).not.toContain(SENTINEL);
      // Final model-facing result still never carries the preview.
      expect(JSON.stringify(result.details)).not.toContain(SENTINEL);
      expect(host.state.sendCalls).toBe(1);
    } finally { await host.cleanup(); }
  });

  it("completes the send exactly once when the progress callback throws synchronously", async () => {
    const host = await setup(true);
    try {
      vi.mocked(host.ctx.ui.select).mockResolvedValue("1. Allow [allow_once]");
      let calls = 0;
      const result = await host.execute("acp_send_message", { session_id: "s1", text: "hello" }, undefined, () => { calls++; throw new Error("renderer boom"); });
      expect((result.details as { terminal: boolean }).terminal).toBe(true);
      expect(calls).toBeGreaterThan(0);
      expect(host.state.sendCalls).toBe(1);
    } finally { await host.cleanup(); }
  });

  it("completes the send when the progress callback returns a rejected promise", async () => {
    const host = await setup(true);
    try {
      vi.mocked(host.ctx.ui.select).mockResolvedValue("1. Allow [allow_once]");
      const result = await host.execute("acp_send_message", { session_id: "s1", text: "hello" }, undefined, () => Promise.reject(new Error("async renderer boom")));
      expect((result.details as { terminal: boolean }).terminal).toBe(true);
      expect(host.state.sendCalls).toBe(1);
    } finally { await host.cleanup(); }
  });

  it("renders the real message id, phase and stall risk from a real onUpdate partial at 40/80 columns", async () => {
    const host = await setup(false, "running");
    try {
      const updates: AgentToolResult<Record<string, unknown>>[] = [];
      await host.execute("acp_send_message", { session_id: "s1", text: "hello" }, undefined, update => updates.push(update));
      const partial = updates.find(update => {
        const details = update.details as { state?: string; activity?: { stalled?: boolean } } | undefined;
        return details?.state === "running" && details.activity?.stalled === true;
      });
      expect(partial).toBeDefined();
      const details = partial!.details as { message_id?: string; activity?: Record<string, unknown> };
      // Wiring: the id lives on details (present regardless of activity); activity holds only metrics.
      expect(details.message_id).toBe(MESSAGE_ID);
      expect(details.activity?.message_id).toBeUndefined();
      // Model-facing fields stay empty and carry neither the id nor the preview.
      expect(partial!.content).toEqual([{ type: "text", text: "" }]);
      expect(partial!.structuredContent).toEqual({});
      for (const field of [JSON.stringify(partial!.content), JSON.stringify(partial!.structuredContent)]) {
        expect(field).not.toContain(MESSAGE_ID);
        expect(field).not.toContain(SENTINEL);
      }
      const send = host.tools.get("acp_send_message")!;
      const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
      for (const width of [40, 80]) {
        const lines = (send.renderResult!(partial!, { isPartial: true } as never, theme, {} as never) as { render(w: number): string[] }).render(width);
        const joined = lines.join("\n");
        expect(joined).toContain("stalled");
        expect(joined).toContain("tool_use");
        expect(joined).toContain("12s since progress");
        expect(joined).toContain(MESSAGE_ID.slice(0, 12)); // at least the id prefix stays visible
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    } finally { await host.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// Monitor-level isolation, driven directly (portable, no host internals).
// ---------------------------------------------------------------------------

function monitorHarness(options: { ui?: boolean; emptyOutput?: boolean } = {}) {
  const ref = { session_id: "s1", message_id: "m1" };
  let terminal = false;
  const calls: string[] = [];
  const connection: BridgeConnection = {
    async call(name) {
      calls.push(name);
      if (name === "message_status") {
        return terminal
          ? { state: "completed", terminal: true, questions: [], result: { text: "done" } }
          : { state: "running", terminal: false, questions: [], ...(options.emptyOutput ? {} : { progress: { text: SENTINEL } }) };
      }
      if (name === "cancel_message") { terminal = true; return { state: "cancelled", terminal: true }; }
      return {};
    },
  };
  const ctx = context({ hasUI: options.ui ?? true });
  const monitor = new MessageMonitor(connection, new InteractionRouter(100), ctx, 5);
  return { monitor, ctx, ref, calls, finish: () => { terminal = true; } };
}

describe("monitor update isolation", () => {
  it("isolates a throwing running update from a sibling waiter and from completion", async () => {
    const { monitor, ref, finish } = monitorHarness();
    let goodPreviews = 0;
    const bad = monitor.wait(ref, context(), undefined, () => { throw new Error("bad running update"); });
    const good = monitor.wait(ref, context(), undefined, (_status, preview) => { goodPreviews++; return preview; });
    await vi.waitFor(() => expect(goodPreviews).toBeGreaterThan(0));
    finish();
    expect((await bad).terminal).toBe(true);
    expect((await good).terminal).toBe(true);
    await monitor.stop();
  });

  it("completes despite throwing and async-rejecting terminal updates", async () => {
    const { monitor, ref, finish } = monitorHarness();
    const sync = monitor.wait(ref, context(), undefined, () => { throw new Error("terminal sync"); });
    const asyncReject = monitor.wait(ref, context(), undefined, () => Promise.reject(new Error("terminal async")));
    finish();
    expect((await sync).terminal).toBe(true);
    expect((await asyncReject).terminal).toBe(true);
    await monitor.stop();
  });

  it("still completes with empty output and without UI", async () => {
    const { monitor, ref, finish } = monitorHarness({ ui: false, emptyOutput: true });
    const promise = monitor.wait(ref, context({ hasUI: false }));
    finish();
    expect((await promise).terminal).toBe(true);
    await monitor.stop();
  });

  it("still cancels the remote message on abort", async () => {
    const { monitor, ref, calls } = monitorHarness();
    const controller = new AbortController();
    const promise = monitor.wait(ref, context(), controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(calls.filter(name => name === "cancel_message")).toHaveLength(1);
    await monitor.stop();
  });
});
