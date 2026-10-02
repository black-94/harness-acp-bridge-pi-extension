import { describe, it, expect, vi } from "vitest";
import { InteractionRouter } from "../src/interactions.ts";
import { context, askContext, permission, information } from "./helpers.ts";

const signal = () => new AbortController().signal;
const router = () => new InteractionRouter(100);

describe("ACP reverse interactions", () => {
  it("prefers ask_user and maps labels back to permission option ids", async () => {
    const ctx = askContext({ status: "answered", answers: [{ id: "permission", selections: ["2. Reject [reject_once]"] }] });
    expect(await router().resolve(permission(), ctx, signal(), ctx))
      .toEqual({ answer: "accept", response: { option_id: "deny" } });
    expect(ctx.executeTool).toHaveBeenCalledWith("ask_user", expect.objectContaining({ timeoutPerQuestionMs: 100 }), { signal: expect.any(AbortSignal) });
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
  it.each([["aborted", "cancel"], ["timeout", "timeout"]])("does not re-ask after %s", async (status, answer) => {
    const ctx = askContext({ status, answers: [] });
    expect(await router().resolve(permission(), ctx, signal(), ctx)).toEqual({ answer });
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
  it("does not infer a permission from free text or an unknown selection", async () => {
    const ctx = askContext({ status: "answered", answers: [{ selections: [], freeText: "allow" }] });
    await expect(router().resolve(permission(), ctx, signal(), ctx)).rejects.toThrow("explicitly selected");
  });
  it("does not infer a result from human-readable tool output", async () => {
    const ctx = askContext(undefined);
    vi.mocked(ctx.executeTool).mockResolvedValue({
      result: { content: [{ type: "text", text: "User said allow" }], details: undefined }, isError: false,
      toolCall: { type: "toolCall", id: "nested", name: "ask_user", arguments: {} },
    });
    await expect(router().resolve(permission(), ctx, signal(), ctx)).rejects.toThrow("structured answer");
  });
  it("falls back to native select when ask_user is not callable", async () => {
    const ctx = context();
    vi.mocked(ctx.ui.select).mockResolvedValue("1. Allow [allow_once]");
    expect(await router().resolve(permission(), ctx, signal(), ctx)).toEqual({ answer: "accept", response: { option_id: "allow" } });
    expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining('"command": "ls"'), expect.any(Array), expect.objectContaining({ timeout: 100 }));
  });
  it("falls back only when ask_user could not enter its UI", async () => {
    const ctx = askContext({ status: "error", error: { code: "unsupported_mode" } });
    vi.mocked(ctx.ui.select).mockResolvedValue("2. Reject [reject_once]");
    expect(await router().resolve(permission(), ctx, signal(), ctx)).toEqual({ answer: "accept", response: { option_id: "deny" } });
  });
  it("does not bypass an invalid ask_user configuration", async () => {
    const ctx = askContext({ status: "error", error: { code: "invalid_config", message: "bad config" } });
    await expect(router().resolve(permission(), ctx, signal(), ctx)).rejects.toThrow("bad config");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
  it("returns cancel on native dismissal, never approves", async () => {
    const ctx = context();
    expect(await router().resolve(permission(), ctx, signal())).toEqual({ answer: "cancel" });
  });
  it("returns timeout for an expired native deadline", async () => {
    const ctx = context();
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(101);
    expect(await router().resolve(permission(), ctx, signal())).toEqual({ answer: "timeout" });
    now.mockRestore();
  });
  it("leaves interactions pending without UI", async () => {
    const ctx = context({ hasUI: false, mode: "print" });
    expect(await router().resolve(permission(), ctx, signal())).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
  it("uses native UI for more than 5 permission options without dropping options", async () => {
    const ctx = askContext({ status: "answered" });
    const options = Array.from({ length: 6 }, (_, i) => ({ optionId: String(i), name: "Allow", kind: "allow_once" }));
    vi.mocked(ctx.ui.select).mockResolvedValue("6. Allow [allow_once]");
    expect(await router().resolve(permission({ options }), ctx, signal(), ctx)).toEqual({ answer: "accept", response: { option_id: "5" } });
    expect(ctx.executeTool).not.toHaveBeenCalled();
  });
  it("collects and validates typed information fields via ask_user", async () => {
    const ctx = askContext({ status: "answered", answers: [
      { id: "field_0", freeText: "hello", selections: [] },
      { id: "field_1", selections: ["2. false"] },
      { id: "field_2", freeText: "3", selections: [] },
    ] });
    const request = information({ type: "object", properties: {
      name: { type: "string" }, ready: { type: "boolean" }, count: { type: "integer" },
    }, required: ["name", "ready", "count"] });
    expect(await router().resolve(request, ctx, signal(), ctx))
      .toEqual({ answer: "accept", response: { name: "hello", ready: false, count: 3 } });
  });
  it("collects typed fields through native input and select", async () => {
    const ctx = context();
    vi.mocked(ctx.ui.input).mockResolvedValueOnce("7").mockResolvedValueOnce("");
    vi.mocked(ctx.ui.select).mockResolvedValue('2. "blue"');
    const request = information({ type: "object", properties: {
      count: { type: "integer", minimum: 1 }, note: { type: "string" }, color: { type: "string", enum: ["red", "blue"] },
    }, required: ["count", "color"] });
    expect(await router().resolve(request, ctx, signal())).toEqual({ answer: "accept", response: { count: 7, color: "blue" } });
  });
  it("accepts an explicit JSON object for complex or unspecified forms", async () => {
    const ctx = context();
    vi.mocked(ctx.ui.input).mockResolvedValue('{"nested":{"a":true}}');
    expect(await router().resolve(information({ type: "object" }), ctx, signal()))
      .toEqual({ answer: "accept", response: { nested: { a: true } } });
  });
  it("rejects invalid schema values rather than silently coercing them", async () => {
    const ctx = context();
    vi.mocked(ctx.ui.input).mockResolvedValue("0");
    await expect(router().resolve(information({ type: "object", properties: { count: { type: "integer", minimum: 1 } } }), ctx, signal())).rejects.toThrow("Invalid ACP answer");
  });
  it("validates formats and does not use a default without a user answer", async () => {
    const ctx = context();
    vi.mocked(ctx.ui.input).mockResolvedValue("invalid");
    await expect(router().resolve(information({ type: "object", properties: {
      email: { type: "string", format: "email", default: "user@example.com" },
    }, required: ["email"] }), ctx, signal())).rejects.toThrow("Invalid ACP answer");
  });
  it("aborts before showing UI", async () => {
    const ctx = context();
    const controller = new AbortController();
    controller.abort();
    await expect(router().resolve(permission(), ctx, controller.signal)).rejects.toThrow();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
  it("serializes concurrent dialogs across sessions", async () => {
    const ctx = context();
    let release!: (value: string) => void;
    vi.mocked(ctx.ui.select).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue("2. Reject [reject_once]");
    const instance = router();
    const first = instance.resolve(permission(), ctx, signal());
    const second = instance.resolve(permission(), ctx, signal());
    await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalledTimes(1));
    release("1. Allow [allow_once]");
    await first;
    await second;
    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
  });
});
