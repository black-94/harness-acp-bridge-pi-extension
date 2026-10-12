import { describe, it, expect, vi } from "vitest";
import { InteractionRouter } from "../src/interactions.ts";
import type { Question } from "../src/interactions.ts";
import { context, askContext, permission, information, askVerifier } from "./helpers.ts";
import { assertAskUserContract } from "./ask-user-contract.ts";

const signal = (): AbortSignal => new AbortController().signal;
const router = (): InteractionRouter => new InteractionRouter(100, askVerifier());

/** Resolve a question through the router and capture the exact ask_user payload it produced. */
async function capture(question: Question, data: unknown): Promise<Record<string, unknown>> {
  const ctx = askContext(data);
  await router().resolve(question, ctx, signal(), ctx);
  expect(ctx.executeTool).toHaveBeenCalledTimes(1);
  const payload = vi.mocked(ctx.executeTool).mock.calls[0]![1] as Record<string, unknown>;
  assertAskUserContract(payload);
  return payload;
}

const info = (properties: Record<string, unknown>, required?: string[]): Question =>
  information({ type: "object", properties, ...(required ? { required } : {}), additionalProperties: false });

const answer = (value: Record<string, unknown>): unknown => ({ status: "answered", answers: [{ id: "form", selections: [], value }] });
const wholeAnswer = (freeText: string): unknown => ({ status: "answered", answers: [{ id: "response", freeText }] });

type Payload = {
  allowFreeText?: boolean;
  questions: Array<{ id: string; kind: string; prompt?: string; fields?: Array<{ name?: string; kind?: string; required?: boolean; options?: Array<{ label: string; preview?: string }> }> }>;
};

describe("ask_user mapping: typed fields", () => {
  it("uses kind=bool for an unrestricted boolean and preserves false", async () => {
    const q = info({ flag: { type: "boolean" } }, ["flag"]);
    const ctx = askContext(answer({ flag: false }));
    expect(await router().resolve(q, ctx, signal(), ctx)).toEqual({ answer: "accept", content: { flag: false } });
    const payload = await capture(q, answer({ flag: false }));
    expect((payload as Payload).questions[0]!.fields![0]!.kind).toBe("bool");
  });

  it("never widens an enum/const boolean restriction into a free bool", async () => {
    const q = info({ opened: { type: "boolean", enum: [true] } }, ["opened"]);
    const payload = await capture(q, answer({ opened: "1. true" }));
    const field = (payload as Payload).questions[0]!.fields![0]!;
    expect(field.kind).toBe("single");
    expect(field.options).toHaveLength(1);
    // A typed `false` or a label that was never offered must be refused, never coerced to `true`.
    const ctxFalse = askContext(answer({ opened: false }));
    await expect(router().resolve(q, ctxFalse, signal(), ctxFalse)).rejects.toThrow("no option label");
    const ctxLabel = askContext({ status: "answered", answers: [{ id: "form", selections: [], value: { opened: "1. false" } }] });
    await expect(router().resolve(q, ctxLabel, signal(), ctxLabel)).rejects.toThrow("No offered option");
  });

  it("maps a single enum label back to the original typed value", async () => {
    const q = info({ level: { type: "integer", enum: [1, 2, 3] } }, ["level"]);
    const ctx = askContext(answer({ level: "2. 2" }));
    expect(await router().resolve(q, ctx, signal(), ctx)).toEqual({ answer: "accept", content: { level: 2 } });
  });

  it("uses kind=multi for array + items.enum and restores the typed array", async () => {
    const q = info({ tags: { type: "array", items: { type: "string", enum: ["a", "b"] } } }, ["tags"]);
    const payload = await capture(q, answer({ tags: ['2. "b"'] }));
    const field = (payload as Payload).questions[0]!.fields![0]!;
    expect(field.kind).toBe("multi");
    // A schema-required array whose empty form is legal stays optional at the protocol level.
    expect(field.required).toBeUndefined();
  });

  it("keeps empty [] legal for a required array and rejects an omitted minItems>0 array", async () => {
    const emptyOk = info({ tags: { type: "array", items: { enum: ["a", "b"] } } }, ["tags"]);
    const ctx = askContext(answer({}));
    expect(await router().resolve(emptyOk, ctx, signal(), ctx)).toEqual({ answer: "accept", content: { tags: [] } });

    const minOne = info({ tags: { type: "array", items: { enum: ["a", "b"] }, minItems: 1 } }, ["tags"]);
    const payload = await capture(minOne, answer({ tags: ['1. "a"'] }));
    expect((payload as Payload).questions[0]!.fields![0]!.required).toBe(true);
    const missing = askContext(answer({}));
    await expect(router().resolve(minOne, missing, signal(), missing)).rejects.toThrow("omitted required field");
  });

  it("converts number/integer/free-form array input back to typed JSON", async () => {
    const q = info({ n: { type: "number" }, i: { type: "integer" }, arr: { type: "array", items: { type: "string" } } }, ["n", "i", "arr"]);
    const ctx = askContext(answer({ n: "1.5", i: "2", arr: '["x","y"]' }));
    expect(await router().resolve(q, ctx, signal(), ctx))
      .toEqual({ answer: "accept", content: { n: 1.5, i: 2, arr: ["x", "y"] } });
  });

  it("still validates numbers against the schema rather than coercing silently", async () => {
    const q = info({ count: { type: "integer", minimum: 1 } }, ["count"]);
    const ctx = askContext(answer({ count: "0" }));
    await expect(router().resolve(q, ctx, signal(), ctx)).rejects.toThrow("Invalid ACP answer");
  });
});

describe("ask_user mapping: forms and fallbacks", () => {
  it("aggregates 6..10 fields into a single simple-form question", async () => {
    const value = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}`, `v${i}`]));
    const q = info(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}`, { type: "string" }])), ["f0"]);
    const payload = await capture(q, answer(value));
    const question = (payload as Payload).questions[0]!;
    expect((payload as Payload).questions).toHaveLength(1);
    expect(question.kind).toBe("simple-form");
    expect(question.fields).toHaveLength(7);
  });

  it("omits optional fields and rejects an omitted required one", async () => {
    const optional = info({ note: { type: "string" } });
    const ctx = askContext(answer({}));
    expect(await router().resolve(optional, ctx, signal(), ctx)).toEqual({ answer: "accept", content: {} });

    const required = info({ note: { type: "string" } }, ["note"]);
    const missing = askContext(answer({}));
    await expect(router().resolve(required, missing, signal(), missing)).rejects.toThrow("omitted required field");
  });

  it("does not apply a schema default without a user answer", async () => {
    const q = info({ email: { type: "string", format: "email", default: "user@example.com" } }, ["email"]);
    const ctx = askContext(answer({}));
    await expect(router().resolve(q, ctx, signal(), ctx)).rejects.toThrow("omitted required field");
  });

  it("degrades unsafe/nested/combined small schemas to a whole-object JSON input", async () => {
    const cases: Record<string, Record<string, unknown>> = {
      unsafeName: { "a.b": { type: "string" } },
      nested: { a: { type: "object", properties: { b: { type: "string" } } } },
      combined: { a: { anyOf: [{ type: "string" }, { type: "number" }] } },
    };
    for (const [name, properties] of Object.entries(cases)) {
      const payload = await capture(information({ type: "object", properties }), wholeAnswer("{}"));
      const question = (payload as Payload).questions[0]!;
      expect(question.kind, name).toBe("input");
      expect(question.id, name).toBe("response");
      // The bare JSON box still shows the expected fields/schema.
      expect(question.prompt, name).toContain("Schema:");
    }
  });

  it("disables free text on restricted single/multi/permission questions", async () => {
    const single = await capture(info({ color: { type: "string", enum: ["red", "blue"] } }, ["color"]), answer({ color: '2. "blue"' }));
    expect(single.allowFreeText).toBe(false);
    const perm = await capture(permission(), { status: "answered", answers: [{ id: "permission", selections: ["1. Allow [allow_once]"] }] });
    expect(perm.allowFreeText).toBe(false);
  });

  it("leaves the question pending without UI instead of fabricating an answer", async () => {
    const ctx = context({ hasUI: false, mode: "print" });
    expect(await router().resolve(info({ note: { type: "string" } }, ["note"]), ctx, signal(), ctx)).toBeUndefined();
    expect(ctx.executeTool).not.toHaveBeenCalled();
    expect(ctx.ui.input).not.toHaveBeenCalled();
  });

  it("never infers an answer from usedDefault or a missing typed value", async () => {
    const q = info({ note: { type: "string" }, level: { type: "string", enum: ["lo", "hi"] } });
    const ctx = askContext({ status: "answered", answers: [{ id: "form", selections: [], usedDefault: true, value: {} }] });
    expect(await router().resolve(q, ctx, signal(), ctx)).toEqual({ answer: "accept", content: {} });
  });
});

describe("ask_user mapping: description is carried in full", () => {
  it("carries a >500 URL from an option-bearing field's description in the option preview", async () => {
    const url = `https://auth.example.com/login?state=${"a".repeat(600)}&scope=openid`;
    const q = info({ opened: { type: "boolean", enum: [true], description: `Confirm after visiting ${url}` } }, ["opened"]);
    const ctx = askContext(answer({ opened: "1. true" }));
    expect(await router().resolve(q, ctx, signal(), ctx)).toEqual({ answer: "accept", content: { opened: true } });
    const payload = vi.mocked(ctx.executeTool).mock.calls[0]![1] as Payload;
    assertAskUserContract(payload);
    const preview = payload.questions[0]!.fields![0]!.options![0]!.preview!;
    expect(preview).toContain(url);
    expect(preview.length).toBeLessThanOrEqual(4000);
    expect(payload.questions[0]!.prompt!.length).toBeLessThanOrEqual(500);
  });

  it("carries a fitting bool field description in the form prompt", async () => {
    const q = info({ flag: { type: "boolean", description: "Enable the beta channel?" } }, ["flag"]);
    const payload = await capture(q, answer({ flag: true }));
    expect((payload as Payload).questions[0]!.prompt).toContain("Enable the beta channel?");
  });

  it("falls back to native (never truncating) for a >500 whole-object schema hint", async () => {
    const properties = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`field_${i}`, { type: "string" }]));
    const ctx = askContext({ status: "answered", answers: [] });
    vi.mocked(ctx.ui.input).mockResolvedValue("{}");
    expect(await router().resolve(information({ type: "object", properties }), ctx, signal(), ctx))
      .toEqual({ answer: "accept", content: {} });
    expect(ctx.executeTool).not.toHaveBeenCalled();
    const title = vi.mocked(ctx.ui.input).mock.calls[0]![0] as string;
    expect(title).toContain("field_0");
    expect(title).toContain("Schema:");
  });
});

describe("native fallback", () => {
  it("shows every numbered candidate (with its exact value) for a multi field", async () => {
    const q = info({ tags: { type: "array", items: { enum: ["a", "b"] }, description: "Pick your tags" } }, ["tags"]);
    const ctx = context(); // no callable ask_user
    vi.mocked(ctx.ui.input).mockResolvedValue("2");
    expect(await router().resolve(q, ctx, signal(), ctx)).toEqual({ answer: "accept", content: { tags: ["b"] } });
    const title = vi.mocked(ctx.ui.input).mock.calls[0]![0] as string;
    expect(title).toContain('1. "a"');
    expect(title).toContain('2. "b"');
    expect(title).toContain("Pick your tags"); // full description, not a truncated label
  });

  it("rejects an invalid multi token and treats a multi dismissal as a plain cancel", async () => {
    const q = info({ tags: { type: "array", items: { enum: ["a", "b"] } } }, ["tags"]);
    const invalid = context();
    vi.mocked(invalid.ui.input).mockResolvedValue("x");
    await expect(router().resolve(q, invalid, signal(), invalid)).rejects.toThrow("Invalid option number");

    const dismissed = context();
    vi.mocked(dismissed.ui.input).mockResolvedValue(undefined);
    expect(await router().resolve(q, dismissed, signal(), dismissed)).toEqual({ answer: "cancel" });
  });

  it("offers a real skip entry for optional bool/single and omits the field", async () => {
    const q = info({ flag: { type: "boolean" }, color: { type: "string", enum: ["red", "blue"] } });
    const ctx = context();
    vi.mocked(ctx.ui.select).mockResolvedValueOnce("(skip optional field)").mockResolvedValueOnce("(skip optional field)");
    expect(await router().resolve(q, ctx, signal(), ctx)).toEqual({ answer: "accept", content: {} });
    expect(vi.mocked(ctx.ui.select).mock.calls[0]![1]).toEqual(["1. true", "2. false", "(skip optional field)"]);
    expect(vi.mocked(ctx.ui.select).mock.calls[1]![1]).toEqual(['1. "red"', '2. "blue"', "(skip optional field)"]);
  });

  it("does not offer a skip entry on a required single", async () => {
    const q = info({ color: { type: "string", enum: ["red", "blue"] } }, ["color"]);
    const ctx = context();
    vi.mocked(ctx.ui.select).mockResolvedValue("(skip optional field)");
    await expect(router().resolve(q, ctx, signal(), ctx)).rejects.toThrow("Invalid field selection");
    expect(vi.mocked(ctx.ui.select).mock.calls[0]![1]).toEqual(['1. "red"', '2. "blue"']);
  });

  it("keeps a long input description verbatim in the native title", async () => {
    const desc = `Read this before answering: ${"x".repeat(600)}`;
    const q = info({ note: { type: "string", description: desc } }, ["note"]);
    const ctx = askContext({ status: "answered", answers: [] });
    vi.mocked(ctx.ui.input).mockResolvedValue("typed");
    expect(await router().resolve(q, ctx, signal(), ctx)).toEqual({ answer: "accept", content: { note: "typed" } });
    expect(ctx.executeTool).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.input).mock.calls[0]![0]).toContain(desc);
  });
});
