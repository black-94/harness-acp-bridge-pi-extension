import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { context } from "./helpers.ts";

const SENTINEL = "PREVIEW-SENTINEL-DO-NOT-ENTER-CONTEXT";

interface StubState { answered: boolean; sessions: Array<Record<string, unknown>>; requests: string[] }
function stubServer() {
  const state: StubState = { answered: false, sessions: [], requests: [] };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const method = (request.url ?? "").replace(/^\/api\//, "");
      state.requests.push(method);
      const params = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const question = { request_id: "req-1", kind: "permission", title: "Run bash", message: "Allow command?", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }], schema: null };
      if (method === "message_status") {
        if (params.session_id === "invalid") {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: { code: "session_not_found", message: "unknown session_id" } }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(state.answered
          ? { ok: true, data: { session_id: "s1", message_id: "m1", state: "completed", terminal: true, questions: [], result: { text: "final:hello", reasoning: "", tool_calls: [], stop_reason: "end_turn", raw_result: null } } }
          : { ok: true, data: { session_id: "s1", message_id: "m1", state: "waiting_input", terminal: false, questions: [question] } }));
        return;
      }
      if (method === "answer_question") {
        state.answered = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, data: { session_id: "s1", message_id: "m1", request_id: params.request_id, answered: true } }));
        return;
      }
      const bodies: Record<string, unknown> = {
        ping: { ok: true, data: { status: "ok", protocol_version: 2, sessions: 0 } },
        search_harness: { ok: true, data: { harnesses: { fake: {} } } },
        create_session: { ok: true, data: { session_id: "s1", state: "ready" } },
        send_message: { ok: true, data: { message_id: "m1" } },
        live_output: { ok: true, data: { session_id: "s1", events: [{ type: "answer", text: SENTINEL, seq: 1, timestamp: "now", message_id: "m1", complete: true }], next_cursor: "c1", has_more: false, session_closed: false, terminal: false } },
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

async function setup(hasUI = true) {
  const { server, state } = stubServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), "pi-acp-ext-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi", "harness-acp-bridge.json"), JSON.stringify({
    baseUrl, autoStart: false, pollIntervalMs: 5, interactionTimeoutMs: 5000, requestTimeoutMs: 5000,
  }));
  // Isolate from the real user agent directory so a stale global settings file cannot leak in.
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
  vi.stubEnv("PI_ACP_BRIDGE_SETTINGS", "");
  vi.stubEnv("HARNESS_ACP_BRIDGE_CONFIG", "");

  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const commands = new Map<string, unknown>();
  const messages = vi.fn();
  const api = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: unknown) => commands.set(name, options),
    on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, callback),
    appendEntry: vi.fn(), getActiveTools: () => [...tools.keys()], getAllTools: () => [...tools.values()],
    sendUserMessage: messages, sendMessage: messages,
  } as unknown as ExtensionAPI;
  const ctx = context({ cwd: dir, hasUI });
  Object.assign(ctx, { sessionManager: { getBranch: () => [], getEntries: () => [] } });
  extension(api);
  await events.get("session_start")!({}, ctx);
  const execute = (name: string, args: unknown, signal?: AbortSignal, onUpdate?: (result: AgentToolResult<Record<string, unknown>>) => void) =>
    tools.get(name)!.execute("call-1", args, signal, onUpdate as never, ctx as ExtensionToolContext) as Promise<AgentToolResult<Record<string, unknown>>>;
  return { api, tools, events, commands, ctx, messages, execute, state, async cleanup() { await events.get("session_shutdown")!({}, ctx); } };
}

describe("Pi tools over the HTTP bridge", () => {
  it("registers the twelve acp_ tools plus acp_wait and never uses MCP or a new user turn", async () => {
    const host = await setup();
    try {
      expect(host.tools.size).toBe(13);
      expect([...host.tools.keys()]).toContain("acp_send_message");
      expect([...host.tools.keys()]).toContain("acp_wait");
      expect([...host.tools.keys()].some(name => name.includes("mcp"))).toBe(false);
      const result = await host.execute("acp_ping", {});
      expect((result.details as { status: string }).status).toBe("ok");
      expect(host.messages).not.toHaveBeenCalled();
    } finally { await host.cleanup(); }
  });

  it("waits synchronously, keeps preview out of the model-facing result, and answers through native UI", async () => {
    const host = await setup(true);
    try {
      vi.mocked(host.ctx.ui.select).mockResolvedValue("1. Allow [allow_once]");
      const updates: AgentToolResult<Record<string, unknown>>[] = [];
      const result = await host.execute("acp_send_message", { session_id: "s1", text: "hello" }, undefined, update => updates.push(update));
      expect((result.details as { terminal: boolean }).terminal).toBe(true);
      expect((result.details as { result: { text: string } }).result.text).toBe("final:hello");
      // No preview leaks into anything model-facing.
      expect(JSON.stringify(result.content)).not.toContain(SENTINEL);
      expect(JSON.stringify(result.structuredContent)).not.toContain(SENTINEL);
      expect(JSON.stringify(result.details)).not.toContain(SENTINEL);
      // Preview is delivered as a UI-only update: a contract-shaped partial result with a single
      // empty text block plus an empty structured object, preview only in details.
      const previewUpdate = updates.find(update => JSON.stringify(update.details ?? {}).includes(SENTINEL));
      expect(previewUpdate).toBeDefined();
      expect(previewUpdate!.content).toEqual([{ type: "text", text: "" }]);
      expect(previewUpdate!.structuredContent).toEqual({});
      // The partial update itself must not carry the preview into any model-facing field.
      expect(JSON.stringify(previewUpdate!.content)).not.toContain(SENTINEL);
      expect(JSON.stringify(previewUpdate!.structuredContent)).not.toContain(SENTINEL);
      expect(host.messages).not.toHaveBeenCalled();
    } finally { await host.cleanup(); }
  });

  it("returns waiting_input without a UI and never fabricates a decision", async () => {
    const host = await setup(false);
    try {
      const result = await host.execute("acp_send_message", { session_id: "s1", text: "hello" });
      expect((result.details as { state: string }).state).toBe("waiting_input");
      expect(host.ctx.ui.select).not.toHaveBeenCalled();
    } finally { await host.cleanup(); }
  });

  it("renders the preview through a UI-only renderResult that never enters the result", async () => {
    const host = await setup();
    try {
      // A real ANSI-colored theme: the renderer must not count escapes as width or cut them off.
      const theme = { fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[0m` } as unknown as Theme;
      const send = host.tools.get("acp_send_message")!;
      const wait = host.tools.get("acp_wait")!;
      expect(typeof send.renderResult).toBe("function");
      expect(typeof wait.renderResult).toBe("function");
      const render = (result: AgentToolResult<Record<string, unknown>>, width: number): string[] =>
        (send.renderResult!(result, { isPartial: true } as never, theme, {} as never) as { render(width: number): string[] }).render(width);

      const partial = { content: [], details: { state: "running", preview: `${SENTINEL} 汉字😀 e\u0301 tail` } } as unknown as AgentToolResult<Record<string, unknown>>;
      const wide = render(partial, 80);
      expect(wide.join("\n")).toContain(SENTINEL);
      expect(wide.join("")).toContain("\x1b["); // ANSI preserved, not stripped by truncation
      for (const line of wide) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
      // Wide CJK/emoji and combining marks stay intact after stripping ANSI.
      const stripped = wide.map(line => stripTerminalSequences(line)).join("");
      expect(stripped).toContain("😀");
      expect(stripped).toContain("e\u0301");

      // Every width (including 0, 1, and widths that split a wide char) keeps the invariant.
      for (const width of [0, 1, 2, 3, 5, 8]) {
        for (const line of render(partial, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      for (const line of render(partial, 0)) expect(visibleWidth(line)).toBe(0);

      // The final render shows the settled answer, still UI-only.
      const final = { content: [{ type: "text", text: "ANSWER" }], details: { state: "completed", result: { text: "final:hello" } } } as unknown as AgentToolResult<Record<string, unknown>>;
      expect((send.renderResult!(final, { isPartial: false } as never, theme, {} as never) as { render(width: number): string[] }).render(80).join("\n")).toContain("final:hello");

      // Critical risk info must be visible at narrow widths, not only on a very wide terminal.
      const active = { content: [{ type: "text", text: "" }], details: { state: "running", message_id: "msg_abcdef", preview: "PREVIEW-BODY", activity: { observed_phase: "tool_use", seconds_since_progress: 5, stalled: true } } } as unknown as AgentToolResult<Record<string, unknown>>;
      for (const width of [40, 80]) {
        const joined = render(active, width).join("\n");
        expect(joined).toContain("stalled");
        expect(joined).toContain("tool_use");
        expect(joined).toContain("PREVIEW-BODY");
        for (const line of render(active, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      // Waiting on the user shows needs-input, never a stall.
      const waiting = { content: [{ type: "text", text: "" }], details: { state: "waiting_input", preview: "Q?", activity: { observed_phase: "waiting_input", seconds_since_progress: 99, stalled: false } } } as unknown as AgentToolResult<Record<string, unknown>>;
      for (const width of [40, 80]) {
        const joined = render(waiting, width).join("\n");
        expect(joined).toContain("needs input");
        expect(joined).not.toContain("stalled");
        for (const line of render(waiting, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    } finally { await host.cleanup(); }
  });

  it.each(["acp_wait", "acp_send_message"])("uses the correct abort policy for %s", async name => {
    const host = await setup(true);
    try {
      vi.mocked(host.ctx.ui.select).mockImplementation((_title, _options, options) => new Promise(resolve => {
        options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      }));
      const controller = new AbortController();
      const args = name === "acp_wait" ? { session_id: "s1", message_id: "m1" } : { session_id: "s1", text: "hello" };
      const promise = host.execute(name, args, controller.signal);
      await vi.waitFor(() => expect(host.ctx.ui.select).toHaveBeenCalled());
      controller.abort();
      await expect(promise).rejects.toThrow();
      expect(host.state.requests.filter(method => method === "cancel_message")).toHaveLength(name === "acp_wait" ? 0 : 1);
      expect(host.state.requests).not.toContain("answer_question");
      if (name === "acp_wait") {
        host.state.answered = true;
        expect((await host.execute("acp_wait", { session_id: "s1", message_id: "m1" })).details!.terminal).toBe(true);
        expect(host.state.requests.filter(method => method === "send_message")).toHaveLength(0);
      }
    } finally { await host.cleanup(); }
  });

  it("resumes a known message with acp_wait and preserves server error codes", async () => {
    const host = await setup(true);
    try {
      host.state.answered = false;
      vi.mocked(host.ctx.ui.select).mockResolvedValue("1. Allow [allow_once]");
      const result = await host.execute("acp_wait", { session_id: "s1", message_id: "m1" });
      expect((result.details as { terminal: boolean }).terminal).toBe(true);
      await expect(host.execute("acp_message_status", { session_id: "invalid", message_id: "m1" })).rejects.toMatchObject({ code: "session_not_found" });
    } finally { await host.cleanup(); }
  });
});
