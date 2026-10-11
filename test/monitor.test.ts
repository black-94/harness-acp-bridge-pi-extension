import { describe, it, expect, vi } from "vitest";
import { MessageMonitor } from "../src/monitor.ts";
import { InteractionRouter } from "../src/interactions.ts";
import { context, askContext, permission } from "./helpers.ts";
import type { BridgeConnection } from "../src/client.ts";

const ref = { session_id: "s1", message_id: "m1" };
const PREVIEW = "PREVIEW-SENTINEL";

function harness(options: { ui?: boolean; pages?: Array<{ text: string; hasMore: boolean; terminal?: boolean }> } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const state: { terminal: boolean; question: unknown | null; statusCalls: number } = { terminal: false, question: permission(), statusCalls: 0 };
  const queue = options.pages ? [...options.pages] : null;
  const connection: BridgeConnection = {
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "message_status") {
        state.statusCalls++;
        return { state: state.terminal ? "completed" : "waiting_input", terminal: state.terminal, questions: state.terminal || !state.question ? [] : [state.question], ...(state.terminal ? { text: "done", result: { text: "done" } } : {}) };
      }
      if (name === "live_output") {
        if (queue) { const page = queue.shift(); return page ? { events: [{ type: "answer", text: page.text }], next_cursor: `c${calls.length}`, has_more: page.hasMore, terminal: page.terminal ?? false } : { events: [], next_cursor: "end", has_more: false }; }
        return { events: [{ type: "answer", text: PREVIEW }], next_cursor: "p1", has_more: false };
      }
      if (name === "answer_question") { state.question = null; state.terminal = true; return { answered: true }; }
      if (name === "cancel_message") { state.terminal = true; return { state: "cancelled", terminal: true }; }
      return {};
    },
  };
  const ctx = context({ hasUI: options.ui ?? true });
  const settled = vi.fn();
  const monitor = new MessageMonitor(connection, new InteractionRouter(100), ctx, 5, settled);
  return { monitor, calls, ctx, state, settled, finish: () => { state.terminal = true; } };
}

describe("message monitoring", () => {
  it("handles a reverse request with an active ask_user context and streams preview", async () => {
    const { monitor, calls, settled } = harness();
    const toolCtx = askContext({ status: "answered", answers: [{ id: "permission", selections: ["1. Allow [allow_once]"] }] });
    const update = vi.fn();
    const result = await monitor.wait(ref, toolCtx, undefined, update);
    expect(result.text).toBe("done");
    expect(toolCtx.executeTool).toHaveBeenCalledOnce();
    expect(calls).toContainEqual({ name: "answer_question", args: { ...ref, request_id: "req-1", answer: "accept", option_id: "allow" } });
    expect(update).toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(ref);
    await monitor.stop();
  });
  it("answers a permission request through native UI", async () => {
    const { monitor, calls, ctx } = harness();
    vi.mocked(ctx.ui.select).mockResolvedValue("2. Reject [reject_once]");
    const result = await monitor.wait(ref, ctx);
    expect(result.terminal).toBe(true);
    expect(calls).toContainEqual({ name: "answer_question", args: { ...ref, request_id: "req-1", answer: "accept", option_id: "deny" } });
    await monitor.stop();
  });
  it("deduplicates watchers and answers per message", async () => {
    const { monitor, calls, ctx } = harness();
    vi.mocked(ctx.ui.select).mockResolvedValue("1. Allow [allow_once]");
    monitor.start(ref);
    monitor.start(ref);
    await vi.waitFor(() => expect(calls.some(c => c.name === "answer_question")).toBe(true));
    expect(calls.filter(c => c.name === "answer_question")).toHaveLength(1);
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    await monitor.stop();
  });
  it("returns waiting_input without fabricating answers when UI is unavailable", async () => {
    const { monitor, calls } = harness({ ui: false });
    const result = await monitor.wait(ref, context({ hasUI: false }));
    expect(result.state).toBe("waiting_input");
    expect(calls.some(c => c.name === "answer_question")).toBe(false);
    await monitor.stop();
  });
  it("cancels the remote message on waiter abort", async () => {
    const { monitor, calls, ctx } = harness();
    const controller = new AbortController();
    vi.mocked(ctx.ui.select).mockImplementation((_title, _options, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }));
    const promise = monitor.wait(ref, ctx, controller.signal);
    await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalled());
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(calls.some(c => c.name === "cancel_message")).toBe(true);
    await monitor.stop();
  });
  it("dismisses a stale UI when the remote turn becomes terminal", async () => {
    const { monitor, calls, ctx, finish } = harness();
    vi.mocked(ctx.ui.select).mockImplementation((_title, _options, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }));
    const promise = monitor.wait(ref, ctx);
    await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalled());
    finish();
    expect((await promise).terminal).toBe(true);
    expect(calls.some(c => c.name === "answer_question")).toBe(false);
    await monitor.stop();
  });
  it("stops polling and closes UI on shutdown without closing server sessions", async () => {
    const { monitor, calls, ctx } = harness();
    vi.mocked(ctx.ui.select).mockImplementation((_title, _options, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }));
    monitor.start(ref);
    await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalled());
    await monitor.stop();
    const count = calls.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls.length).toBe(count);
    expect(calls.some(c => c.name === "close_session" || c.name === "cancel_message")).toBe(false);
  });
  it("allows a retry after an invalid UI answer", async () => {
    const { monitor, ctx } = harness();
    vi.mocked(ctx.ui.select).mockResolvedValueOnce("invalid").mockResolvedValue("2. Reject [reject_once]");
    await expect(monitor.wait(ref, ctx)).rejects.toThrow("Invalid permission");
    expect((await monitor.wait(ref, ctx)).terminal).toBe(true);
    await monitor.stop();
  });
  it("drains terminal output pages and joins fragments through the cursor", async () => {
    const { monitor, calls } = harness({ pages: [
      { text: "a", hasMore: true },
      { text: "b", hasMore: true, terminal: true },
      { text: "c", hasMore: false, terminal: true },
    ] });
    const updates: string[] = [];
    const result = await monitor.wait(ref, context(), undefined, (_status, preview) => updates.push(preview));
    expect(result.terminal).toBe(true);
    expect(updates.at(-1)).toBe("abc");
    const cursors = calls.filter(c => c.name === "live_output").map(c => c.args.cursor);
    expect(cursors.filter(Boolean).length).toBeGreaterThan(0);
    await monitor.stop();
  });
});
