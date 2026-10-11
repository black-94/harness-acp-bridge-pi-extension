import { describe, it, expect, vi } from "vitest";
import { InteractionRouter } from "../src/interactions.ts";
import { context, askContext, permission, information } from "./helpers.ts";

const signal = (): AbortSignal => new AbortController().signal;
const router = (): InteractionRouter => new InteractionRouter(100);

describe("ACP reverse interactions", () => {
  it("prefers ask_user and maps labels back to permission option ids", async () => {
    const ctx = askContext({ status: "answered", answers: [{ id: "permission", selections: ["2. Reject [reject_once]"] }] });
    expect(await router().resolve(permission(), ctx, signal(), ctx)).toEqual({ answer: "accept", option_id: "deny" });
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
    } as never);
    await expect(router().resolve(permission(), ctx, signal(), ctx)).rejects.toThrow("structured answer");
  });
  it("falls back to native select when ask_user is not callable", async () => {
    const ctx = context();
    vi.mocked(ctx.ui.select).mockResolvedValue("1. Allow [allow_once]");
    expect(await router().resolve(permission(), ctx, signal(), ctx)).toEqual({ answer: "accept", option_id: "allow" });
    expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining('"command": "ls"'), expect.any(Array), expect.objectContaining({ timeout: 100 }));
  });
  it("falls back only when ask_user could not enter its UI", async () => {
    const ctx = askContext({ status: "error", error: { code: "unsupported_mode" } });
    vi.mocked(ctx.ui.select).mockResolvedValue("2. Reject [reject_once]");
    expect(await router().resolve(permission(), ctx, signal(), ctx)).toEqual({ answer: "accept", option_id: "deny" });
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
    expect(await router().resolve(permission({ options }), ctx, signal(), ctx)).toEqual({ answer: "accept", option_id: "5" });
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
      .toEqual({ answer: "accept", content: { name: "hello", ready: false, count: 3 } });
  });
  it("collects typed fields through native input and select", async () => {
    const ctx = context();
    vi.mocked(ctx.ui.input).mockResolvedValueOnce("7").mockResolvedValueOnce("");
    vi.mocked(ctx.ui.select).mockResolvedValue('2. "blue"');
    const request = information({ type: "object", properties: {
      count: { type: "integer", minimum: 1 }, note: { type: "string" }, color: { type: "string", enum: ["red", "blue"] },
    }, required: ["count", "color"] });
    expect(await router().resolve(request, ctx, signal())).toEqual({ answer: "accept", content: { count: 7, color: "blue" } });
  });
  it("accepts an explicit JSON object for complex or unspecified forms", async () => {
    const ctx = context();
    vi.mocked(ctx.ui.input).mockResolvedValue('{"nested":{"a":true}}');
    expect(await router().resolve(information({ type: "object" }), ctx, signal()))
      .toEqual({ answer: "accept", content: { nested: { a: true } } });
  });
  it("rejects invalid schema values rather than silently coercing them", async () => {
    const ctx = context();
    vi.mocked(ctx.ui.input).mockResolvedValue("0");
    await expect(router().resolve(information({ type: "object", properties: { count: { type: "integer", minimum: 1 } } }), ctx, signal())).rejects.toThrow("Invalid ACP answer");
  });
  it("enforces additionalProperties:false via ajv (not silently ignored)", async () => {
    const ctx = context();
    vi.mocked(ctx.ui.input).mockResolvedValue('{"extra":1}');
    await expect(router().resolve(information({ type: "object", additionalProperties: false }), ctx, signal())).rejects.toThrow("Invalid ACP answer");
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

  it("keeps a long auth URL fully in the option preview and caps the ask_user prompt at 500", async () => {
    const url = `https://auth.example.com/login?state=${"a".repeat(600)}&scope=openid`;
    const ctx = askContext({ status: "answered", answers: [{ id: "field_0", selections: ["1. true"] }] });
    const question = information({ type: "object", properties: { opened: { type: "boolean", enum: [true] } }, required: ["opened"] });
    question.message = `Open this URL and complete authentication, then confirm here: ${url}`;
    // A boolean-enum confirm question is a single choice presented via ask_user.
    expect(await router().resolve(question, ctx, signal(), ctx)).toEqual({ answer: "accept", content: { opened: true } });
    const payload = vi.mocked(ctx.executeTool).mock.calls[0]![1] as { questions: Array<{ prompt?: string; options?: Array<{ preview?: string }> }> };
    expect(payload.questions).toHaveLength(1);
    // The real `ask_user` schema rejects prompt > 500, so a legal call must never exceed it.
    expect(payload.questions[0]!.prompt!.length).toBeLessThanOrEqual(500);
    // The full URL survives intact in the option preview (preview limit is 4000).
    const preview = payload.questions[0]!.options![0]!.preview!;
    expect(preview).toContain(url);
    expect(preview.length).toBeLessThanOrEqual(4000);
  });

  it("never sends an input field whose full prompt exceeds ask_user's 500-char limit", async () => {
    const ctx = context(); // no `ask_user` callable
    const long = `Read this context before answering: ${"x".repeat(600)}`;
    const question = information({ type: "object", properties: { note: { type: "string" } }, required: ["note"] });
    question.message = long;
    vi.mocked(ctx.ui.input).mockResolvedValue("typed");
    // Native UI is the fallback (no prompt length limit), so the answer is still collected.
    expect(await router().resolve(question, ctx, signal())).toEqual({ answer: "accept", content: { note: "typed" } });
    const title = vi.mocked(ctx.ui.input).mock.calls[0]![0] as string;
    expect(title).toContain(long);
  });

  it("leaves an over-long input question pending without UI instead of truncating it into ask_user", async () => {
    const ctx = askContext({ status: "answered", answers: [] });
    const question = information({ type: "object", properties: { note: { type: "string" } }, required: ["note"] });
    question.message = `Context: ${"x".repeat(600)}`;
    (ctx as { hasUI: boolean }).hasUI = false;
    expect(await router().resolve(question, ctx, signal(), ctx)).toBeUndefined();
    // It must not smuggle the >500 prompt into executeTool.
    expect(ctx.executeTool).not.toHaveBeenCalled();
  });

  it("falls back to native UI (never truncating) when the message is too long for preview too", async () => {
    const ctx = context();
    const huge = `Context: ${"y".repeat(5000)}`;
    const question = information({ type: "object", properties: { opened: { type: "boolean", enum: [true] } }, required: ["opened"] });
    question.message = huge;
    vi.mocked(ctx.ui.select).mockResolvedValue("1. true");
    expect(await router().resolve(question, ctx, signal())).toEqual({ answer: "accept", content: { opened: true } });
    expect(vi.mocked(ctx.ui.select).mock.calls[0]![0]).toContain(huge);
  });
});
