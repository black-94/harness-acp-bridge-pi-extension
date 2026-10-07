import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { context } from "./helpers.ts";

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-acp-extension-"));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({
    command: process.execPath, args: [resolve("test/fixtures/mcp-server.mjs")],
    pollIntervalMs: 5, requestTimeoutMs: 5000, interactionTimeoutMs: 5000,
  }));
  vi.stubEnv("PI_ACP_BRIDGE_SETTINGS", settings);
  vi.stubEnv("HARNESS_ACP_BRIDGE_SERVER", "");
  vi.stubEnv("HARNESS_ACP_BRIDGE_CONFIG", "");
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const messages = vi.fn();
  const api = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, callback),
    appendEntry: vi.fn(), getActiveTools: () => [...tools.keys()], getAllTools: () => [...tools.values()],
    sendUserMessage: messages, sendMessage: messages,
  } as unknown as ExtensionAPI;
  const ctx = context();
  Object.assign(ctx, { sessionManager: { getBranch: () => [] } });
  extension(api);
  await events.get("session_start")!({}, ctx);
  const execute = (name: string, args: unknown, signal?: AbortSignal) =>
    tools.get(name)!.execute("call-1", args, signal, undefined, ctx);
  const created = await execute("acp_create_session", { cwd: dir, model_id: "fake-model" });
  const session_id = (created.details as { session_id: string }).session_id;
  return { api, tools, ctx, messages, execute, session_id, async cleanup() {
    await events.get("session_shutdown")!({}, ctx);
    rmSync(dir, { recursive: true, force: true });
  } };
}
afterEach(() => vi.unstubAllEnvs());

describe("synchronous Pi tools over real MCP stdio", () => {
  it("acp_send_message stays executing through permissions until the final result", async () => {
    const host = await setup();
    try {
      let approve!: (value: string) => void;
      vi.mocked(host.ctx.ui.select).mockImplementation(() => new Promise(resolve => { approve = resolve; }));
      let finished = false;
      const running = host.execute("acp_send_message", { session_id: host.session_id, text: "hello" }).then(result => { finished = true; return result; });
      await vi.waitFor(() => expect(host.ctx.ui.select).toHaveBeenCalledOnce());
      expect(finished).toBe(false);
      expect(host.messages).not.toHaveBeenCalled();
      approve("1. Allow [allow_once]");
      const result = await running;
      expect((result.details as { terminal: boolean }).terminal).toBe(true);
      expect((result.details as { text: string }).text).toBe("final:hello");
      expect(host.messages).not.toHaveBeenCalled();
      expect(host.tools.has("acp_send")).toBe(false);
      expect((host.tools.get("acp_send_message")!.parameters as { properties: object }).properties).not.toHaveProperty("wait");
      expect(host.tools.size).toBe(13); // 12 discovered tools + wait helper.
    } finally { await host.cleanup(); }
  });
  it("handles consecutive permission and information popups in the same invocation", async () => {
    const host = await setup();
    try {
      vi.mocked(host.ctx.ui.select).mockResolvedValue("1. Allow [allow_once]");
      vi.mocked(host.ctx.ui.input).mockResolvedValue("Ada");
      const result = await host.execute("acp_send_message", { session_id: host.session_id, text: "info" });
      expect((result.details as { text: string }).text).toBe("final:info");
      expect(host.ctx.ui.select).toHaveBeenCalledOnce();
      expect(host.ctx.ui.input).toHaveBeenCalledOnce();
      expect(host.messages).not.toHaveBeenCalled();
    } finally { await host.cleanup(); }
  });
  it("calls installed ask_user without ending the parent operation", async () => {
    const host = await setup();
    try {
      Object.assign(host.ctx, { tools: [{ name: "ask_user" }] });
      vi.mocked(host.ctx.executeTool).mockResolvedValue({
        toolCall: { type: "toolCall", id: "child", name: "ask_user", arguments: {} },
        isError: false,
        result: { content: [], details: { status: "answered", answers: [{ id: "permission", selections: ["1. Allow [allow_once]"] }] } },
      });
      const result = await host.execute("acp_send_message", { session_id: host.session_id, text: "hello" });
      expect((result.details as { terminal: boolean }).terminal).toBe(true);
      expect(host.ctx.executeTool).toHaveBeenCalledOnce();
      expect(host.ctx.ui.select).not.toHaveBeenCalled();
      expect(host.messages).not.toHaveBeenCalled();
    } finally { await host.cleanup(); }
  });
  it("acp_wait resumes a pending message without submitting it again", async () => {
    const host = await setup();
    try {
      Object.assign(host.ctx, { hasUI: false });
      const pending = await host.execute("acp_send_message", { session_id: host.session_id, text: "original" });
      expect((pending.details as { state: string }).state).toBe("waiting_input");
      Object.assign(host.ctx, { hasUI: true });
      vi.mocked(host.ctx.ui.select).mockResolvedValue("1. Allow [allow_once]");
      const result = await host.execute("acp_wait", { session_id: host.session_id, message_id: "msg-1" });
      expect((result.details as { text: string }).text).toBe("final:original");
      expect(host.ctx.ui.select).toHaveBeenCalledOnce();
      expect(host.messages).not.toHaveBeenCalled();
    } finally { await host.cleanup(); }
  });
  it("preserves daemon error codes", async () => {
    const host = await setup();
    try {
      await expect(host.execute("acp_message_result", { session_id: "invalid", message_id: "msg-1" })).rejects.toMatchObject({ code: "unknown_session" });
    } finally { await host.cleanup(); }
  });
  it("allows explicit waiting_input handling without a UI", async () => {
    const host = await setup();
    try {
      Object.assign(host.ctx, { hasUI: false });
      const pending = await host.execute("acp_send_message", { session_id: host.session_id, text: "hello" });
      expect((pending.details as { state: string }).state).toBe("waiting_input");
      await host.execute("acp_answer_question", {
        session_id: host.session_id, message_id: "msg-1", request_id: "permission-1", answer: "reject",
      });
      const result = await host.execute("acp_wait", { session_id: host.session_id, message_id: "msg-1" });
      expect((result.details as { terminal: boolean }).terminal).toBe(true);
    } finally { await host.cleanup(); }
  });
});
