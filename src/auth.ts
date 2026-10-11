/** Interactive client-side driver for the server-owned authentication workflow. */
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { BridgeConnection } from "./client.ts";
import { isRecord } from "./config.ts";
import { InteractionRouter, type Decision, type Question } from "./interactions.ts";

export interface AuthRef { session_id: string }

export function firstAuthQuestion(status: Record<string, unknown>): Question | undefined {
  const questions = Array.isArray(status.questions) ? status.questions : [];
  return questions.filter(isRecord).find(question => typeof question.request_id === "string") as Question | undefined;
}

type QuestionOutcome =
  | { kind: "terminal"; status: Record<string, unknown> }
  | { kind: "waiting_input"; status: Record<string, unknown> }
  | { kind: "changed" };

async function resolveAuthQuestion(
  client: BridgeConnection,
  router: InteractionRouter,
  ref: AuthRef,
  question: Question,
  ctx: ExtensionContext,
  toolCtx: ExtensionToolContext,
  signal: AbortSignal,
  pollIntervalMs: number,
): Promise<QuestionOutcome> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  let done = false;
  let decision: Decision | undefined;
  let failure: unknown;
  const resolving = router.resolve(question, ctx, controller.signal, toolCtx).then(
    value => { decision = value; done = true; },
    error => { failure = error; done = true; },
  );
  try {
    while (!done) {
      await delay(pollIntervalMs, undefined, { signal });
      const current = await client.call("auth_status", { ...ref }, signal);
      if (current.terminal === true) {
        controller.abort();
        return { kind: "terminal", status: current };
      }
      const still = firstAuthQuestion(current);
      if (!still || still.request_id !== question.request_id) {
        controller.abort();
        return { kind: "changed" };
      }
    }
    await resolving.catch(() => { /* captured above */ });
    signal.throwIfAborted();
    if (failure !== undefined) {
      if (controller.signal.aborted) return { kind: "changed" };
      throw failure;
    }

    // Revalidate every result, including a no-UI result, so stale questions are never surfaced or
    // answered after another caller advanced the shared server workflow.
    const current = await client.call("auth_status", { ...ref }, signal);
    if (current.terminal === true) return { kind: "terminal", status: current };
    const still = firstAuthQuestion(current);
    if (!still || still.request_id !== question.request_id) return { kind: "changed" };
    if (decision === undefined) return { kind: "waiting_input", status: current };

    // Authentication questions are scoped by session, so message_id is deliberately absent.
    await client.call("answer_question", { ...ref, request_id: question.request_id, ...decision }, signal);
    return { kind: "changed" };
  } finally {
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

/**
 * Start or resume authentication, consume successive questions, and return the final server
 * workflow state. An outer abort only detaches this caller; it sends no cancel_message and invents
 * no answer. A user cancel/timeout is an explicit Decision and is sent before polling final state.
 */
export async function authenticateSession(
  client: BridgeConnection,
  router: InteractionRouter,
  ref: AuthRef,
  ctx: ExtensionContext,
  toolCtx: ExtensionToolContext,
  signal: AbortSignal,
  pollIntervalMs: number,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  let status = await client.call("authenticate", { ...ref }, signal);
  const answered = new Set<string>();
  for (;;) {
    signal.throwIfAborted();
    if (status.terminal === true) return status;
    // A probe-shaped answer (no workflow `state`) means no flow is live; return it rather than
    // polling a flow that no longer exists.
    if (typeof status.state !== "string") return status;
    const question = firstAuthQuestion(status);
    if (question && !answered.has(question.request_id)) {
      const outcome = await resolveAuthQuestion(client, router, ref, question, ctx, toolCtx, signal, pollIntervalMs);
      if (outcome.kind === "terminal" || outcome.kind === "waiting_input") return outcome.status;
      answered.add(question.request_id);
      status = await client.call("auth_status", { ...ref }, signal);
      continue;
    }
    await delay(pollIntervalMs, undefined, { signal });
    status = await client.call("auth_status", { ...ref }, signal);
  }
}
