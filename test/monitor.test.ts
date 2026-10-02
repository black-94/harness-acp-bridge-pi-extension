import { describe, it, expect, vi } from "vitest";
import { MessageMonitor } from "../src/monitor.ts";
import { InteractionRouter } from "../src/interactions.ts";
import { context, askContext, permission } from "./helpers.ts";
import type { BridgeConnection } from "../src/client.ts";

const ref = { session_id: "s1", message_id: "m1" };
function setup(options: { terminal?: boolean; ui?: boolean } = {}) {
  let terminal = options.terminal ?? false;
  let interaction: unknown = permission();
  const call = vi.fn(async (name: string) => {
    if (name === "message_result") return { state: terminal ? "completed" : "waiting_input", terminal, interaction: terminal ? null : interaction, ...(terminal ? { text: "done" } : {}) };
    if (name === "live_output") return { chunk: "preview", next_offset: 7 };
    if (name === "answer_question") { interaction = null; terminal = true; return { accepted: true }; }
    if (name === "cancel_message") { terminal = true; return { state: "cancelled" }; }
    return {};
  });
  const ctx = context({ hasUI: options.ui ?? true });
  vi.mocked(ctx.ui.select).mockResolvedValue("2. Reject [reject_once]");
  const settled = vi.fn();
  const monitor = new MessageMonitor({ call } as BridgeConnection, new InteractionRouter(100), ctx, 5, settled);
  return { monitor, call, ctx, settled, finish: () => { terminal = true; } };
}

describe("message monitoring", () => {
  it("handles reverse request with active ask_user context and streams preview", async () => {
    const { monitor, call, settled } = setup();
    const toolCtx = askContext({ status: "answered", answers: [{ id: "permission", selections: ["1. Allow [allow_once]"] }] });
    const update = vi.fn();
    const result = await monitor.wait(ref, toolCtx, undefined, update);
    expect(result.text).toBe("done");
    expect(toolCtx.executeTool).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith("answer_question", { ...ref, request_id: "req-1", answer: "accept", response: { option_id: "allow" } }, expect.any(AbortSignal));
    expect(update).toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(ref);
    await monitor.stop();
  });
  it("watches an asynchronous submit using native UI", async () => {
    const { monitor, call, ctx } = setup();
    monitor.start(ref);
    await vi.waitFor(() => expect(call.mock.calls.some(c => c[0] === "answer_question")).toBe(true));
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    await monitor.stop();
  });
  it("deduplicates watchers and answers per message", async () => {
    const { monitor, call, ctx } = setup();
    monitor.start(ref);
    monitor.start(ref);
    await vi.waitFor(() => expect(call.mock.calls.some(c => c[0] === "answer_question")).toBe(true));
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    expect(call.mock.calls.filter(c => c[0] === "answer_question")).toHaveLength(1);
    await monitor.stop();
  });
  it("returns waiting_input without fabricating answers when UI is unavailable", async () => {
    const { monitor, call, ctx } = setup({ ui: false });
    const result = await monitor.wait(ref, ctx);
    expect(result.state).toBe("waiting_input");
    expect(call.mock.calls.some(c => c[0] === "answer_question")).toBe(false);
    await monitor.stop();
  });
  it("cancels the remote message on waiter abort", async () => {
    const { monitor, call, ctx } = setup();
    const controller = new AbortController();
    vi.mocked(ctx.ui.select).mockImplementation((_title, _options, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }));
    const promise = monitor.wait(ref, ctx, controller.signal);
    await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalled());
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(call.mock.calls.some(c => c[0] === "cancel_message")).toBe(true);
    expect(call.mock.calls.some(c => c[0] === "answer_question")).toBe(false);
    await monitor.stop();
  });
  it("dismisses stale UI when the remote turn becomes terminal", async () => {
    const { monitor, call, ctx, finish } = setup();
    vi.mocked(ctx.ui.select).mockImplementation((_title, _options, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }));
    const promise = monitor.wait(ref, ctx);
    await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalled());
    finish();
    expect((await promise).terminal).toBe(true);
    expect(call.mock.calls.some(c => c[0] === "answer_question")).toBe(false);
    await monitor.stop();
  });
  it("stops polling and closes UI on shutdown without closing daemon sessions", async () => {
    const { monitor, call, ctx } = setup();
    vi.mocked(ctx.ui.select).mockImplementation((_title, _options, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }));
    monitor.start(ref);
    await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalled());
    await monitor.stop();
    const count = call.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(call).toHaveBeenCalledTimes(count);
    expect(call.mock.calls.some(c => c[0] === "close_session" || c[0] === "cancel_message")).toBe(false);
  });
  it("allows retry after an invalid UI answer", async () => {
    const { monitor, ctx } = setup();
    vi.mocked(ctx.ui.select).mockResolvedValueOnce("invalid").mockResolvedValue("2. Reject [reject_once]");
    await expect(monitor.wait(ref, ctx)).rejects.toThrow("Invalid permission");
    expect((await monitor.wait(ref, ctx)).terminal).toBe(true);
    await monitor.stop();
  });
});
