/**
 * Opt-in cross-check: every payload the router emits must be accepted by the REAL normalizer of the
 * sibling `../pi-ask-user` package. Run explicitly with `npm run test:protocol`; it is intentionally
 * excluded from the default `npm test` so `pi-extension` stays independently checkable.
 */
import { describe, it, expect, vi } from "vitest";
import { normalizeAskUserRequest } from "../../../../pi-ask-user/src/schema.ts";
import { InteractionRouter } from "../../src/interactions.ts";
import type { Question } from "../../src/interactions.ts";
import { askContext, permission, information, askVerifier } from "../helpers.ts";

const signal = (): AbortSignal => new AbortController().signal;
const router = (): InteractionRouter => new InteractionRouter(100, askVerifier());

async function payloadFor(question: Question, data: unknown): Promise<Record<string, unknown>> {
  const ctx = askContext(data);
  await router().resolve(question, ctx, signal(), ctx);
  expect(ctx.executeTool).toHaveBeenCalledTimes(1);
  return vi.mocked(ctx.executeTool).mock.calls[0]![1] as Record<string, unknown>;
}

/** Normalize with the real package and return the accepted question kinds. */
function normalizedKinds(payload: unknown): string[] {
  const { request, warnings } = normalizeAskUserRequest(payload);
  expect(Array.isArray(warnings)).toBe(true);
  return request.questions.map(question => question.kind);
}

const info = (properties: Record<string, unknown>, required?: string[]): Question =>
  information({ type: "object", properties, ...(required ? { required } : {}), additionalProperties: false });
const formAnswer = (value: Record<string, unknown>): unknown => ({ status: "answered", answers: [{ id: "form", selections: [], value }] });

describe("pi-ask-user protocol acceptance", () => {
  it("accepts a permission single and a flat typed simple-form", async () => {
    const perm = await payloadFor(permission(), { status: "answered", answers: [{ id: "permission", selections: ["1. Allow [allow_once]"] }] });
    expect(normalizedKinds(perm)).toEqual(["single"]);

    const form = await payloadFor(
      info({ name: { type: "string" }, ready: { type: "boolean" } }, ["name", "ready"]),
      formAnswer({ name: "hi", ready: false }),
    );
    expect(normalizedKinds(form)).toEqual(["simple-form"]);
    // Request-level free-text restriction applies to form fields too (see ../pi-ask-user ui/custom.ts).
    expect(normalizeAskUserRequest(form).request.allowFreeText).toBe(false);
  });

  it("accepts a multi field and a whole-object input", async () => {
    const multi = await payloadFor(
      info({ tags: { type: "array", items: { enum: ["a", "b"] } } }, ["tags"]),
      formAnswer({ tags: ['1. "a"'] }),
    );
    expect(normalizedKinds(multi)).toEqual(["simple-form"]);

    const whole = await payloadFor(
      information({ type: "object", properties: { a: { type: "object", properties: { b: { type: "string" } } } } }),
      { status: "answered", answers: [{ id: "response", freeText: "{}" }] },
    );
    expect(normalizedKinds(whole)).toEqual(["input"]);
  });

  it("accepts a 10-field simple-form (the form-field ceiling)", async () => {
    const properties = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, { type: "string" }]));
    const payload = await payloadFor(
      info(properties, ["f0"]),
      formAnswer(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, `v${i}`]))),
    );
    const { request } = normalizeAskUserRequest(payload);
    expect(request.questions[0]!.kind).toBe("simple-form");
    expect(request.questions[0]!.fields).toHaveLength(10);
  });
});
