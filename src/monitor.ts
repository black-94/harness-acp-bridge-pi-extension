/**
 * Authoritative message monitoring for one `session_id`/`message_id`.
 *
 * `message_status` is the ONLY source of truth for state, terminality, pending questions, the
 * optional bounded `progress` snapshot, and the terminal `result`. There is no separate output
 * endpoint: the UI-only preview is derived from the current `status.progress` snapshot each poll
 * (replaced, never appended), and the terminal `result` drives the final update.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { BridgeConnection } from "./client.ts";
import { isRecord } from "./config.ts";
import { InteractionRouter, type Question } from "./interactions.ts";

export interface MessageRef { session_id: string; message_id: string }
export interface WaitOptions { cancelOnAbort?: boolean }
interface Waiter {
  ctx: ExtensionToolContext;
  // Returns `unknown`, not `void`: the host `onUpdate` sink may return a promise, and the caller
  // must hand it back so `guard` can consume a rejection instead of leaking an unhandled one.
  update?: (status: Record<string, unknown>, preview: string) => unknown;
  resolve: (status: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
}
interface Watch {
  ref: MessageRef;
  controller: AbortController;
  done: Promise<void>;
  waiters: Set<Waiter>;
  result?: Record<string, unknown>;
  error?: unknown;
  preview: string;
  prompt?: { id: string; controller: AbortController; done: Promise<void> };
  answered: Set<string>;
  unhandled: Set<string>;
}

const PREVIEW_LIMIT = 16_384;

/**
 * Run a progress or UI side effect so it can never affect message monitoring.
 *
 * A host renderer, status sink, or notification is presentation, not business logic: a throwing
 * one must not reject an unrelated waiter, must not fail a message that already reached its
 * terminal state, and must not stop polling a still-running remote message. Synchronous throws
 * are swallowed; a returned promise has its rejection consumed so no unhandled rejection is
 * created. Genuine failures are deliberately NOT routed through here and keep their normal reject
 * semantics: network and server calls, reverse-request interactions, and watch persistence
 * (`onSettled` → `pi.appendEntry`). `guard` is only for presentation.
 */
function guard(effect: () => unknown): void {
  try {
    const result = effect();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(undefined, () => {});
    }
  } catch { /* presentation-only: never break monitoring or the remote task */ }
}

/**
 * Derive the UI-only preview from the server's bounded `status.progress` snapshot.
 *
 * `progress` is `{ text, reasoning, tool_calls }`. The preview is REPLACED each poll (never
 * appended), so a repeated snapshot cannot duplicate lines, and it is truncated to a bounded
 * length. This text is presentation only and never enters `content`/`structuredContent`.
 */
function progressPreview(status: Record<string, unknown>): string {
  const progress = isRecord(status.progress) ? status.progress : null;
  if (!progress) return "";
  const parts: string[] = [];
  const text = typeof progress.text === "string" ? progress.text : "";
  const reasoning = typeof progress.reasoning === "string" ? progress.reasoning : "";
  if (text) parts.push(text);
  else if (reasoning) parts.push(reasoning);
  if (Array.isArray(progress.tool_calls)) {
    const calls = progress.tool_calls.filter(isRecord).map(call => {
      const name = typeof call.name === "string" ? call.name
        : typeof call.title === "string" ? call.title : "tool";
      const state = typeof call.state === "string" ? ` (${call.state})` : "";
      return `${name}${state}`;
    });
    if (calls.length) parts.push(calls.join("\n"));
  }
  const joined = parts.join("\n");
  return joined.length > PREVIEW_LIMIT ? joined.slice(-PREVIEW_LIMIT) : joined;
}

/** Terminal preview: the final result text, so the last update is the settled answer. */
function resultPreview(status: Record<string, unknown>): string {
  const result = isRecord(status.result) ? status.result : null;
  const text = result && typeof result.text === "string" ? result.text : "";
  return text.length > PREVIEW_LIMIT ? text.slice(-PREVIEW_LIMIT) : text;
}

export class MessageMonitor {
  private watches = new Map<string, Watch>();
  private stopped = false;

  constructor(
    private readonly client: BridgeConnection,
    private readonly router: InteractionRouter,
    private readonly ctx: ExtensionContext,
    private readonly pollIntervalMs: number,
    private readonly onSettled: (ref: MessageRef) => void = () => {},
  ) {}

  private key(ref: MessageRef): string { return JSON.stringify([ref.session_id, ref.message_id]); }

  start(ref: MessageRef): Watch {
    if (this.stopped) throw new Error("Message monitor is stopped");
    const key = this.key(ref);
    const existing = this.watches.get(key);
    if (existing) return existing;
    const watch: Watch = {
      ref, controller: new AbortController(), done: Promise.resolve(), waiters: new Set(),
      preview: "", answered: new Set(), unhandled: new Set(),
    };
    this.watches.set(key, watch);
    watch.done = this.loop(watch).catch(error => {
      watch.error = error;
      for (const waiter of watch.waiters) waiter.reject(error);
      if (!this.stopped && watch.waiters.size === 0) guard(() => this.ctx.ui.notify(`ACP monitor: ${String(error)}`, "warning"));
    }).finally(async () => {
      watch.prompt?.controller.abort();
      await watch.prompt?.done.catch(() => {});
      // The status sink is presentation: a stale/invalid UI context must still let the watch be
      // removed, or every later wait for this message would replay this watch's stored error.
      guard(() => this.ctx.ui.setStatus(`acp:${key}`, undefined));
      this.watches.delete(key);
    });
    return watch;
  }

  async wait(ref: MessageRef, ctx: ExtensionToolContext, signal?: AbortSignal, update?: Waiter["update"], options: WaitOptions = {}): Promise<Record<string, unknown>> {
    // send_message keeps its original cancellation policy; acp_wait only detaches locally.
    const cancelOnAbort = options.cancelOnAbort ?? true;
    if (signal?.aborted) {
      if (cancelOnAbort) await this.client.call("cancel_message", { ...ref }).catch(() => {});
      signal.throwIfAborted();
    }
    const watch = this.start(ref);
    watch.unhandled.clear();
    if (watch.result) return watch.result;
    if (watch.error) throw watch.error;
    let waiter!: Waiter;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      waiter = { ctx, update, resolve, reject };
      watch.waiters.add(waiter);
    });
    const abort = (): void => {
      if (cancelOnAbort || watch.waiters.size === 1) watch.prompt?.controller.abort();
      waiter.reject(signal?.reason ?? new Error("ACP wait aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { return await result; }
    catch (error) {
      if (cancelOnAbort && signal?.aborted && !this.stopped) {
        // Only send_message retains the original remote cancellation on tool abort.
        await this.client.call("cancel_message", { ...ref }).catch(cancelError => {
          guard(() => this.ctx.ui.notify(`ACP cancellation failed; message may still be running: ${String(cancelError)}`, "warning"));
        });
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      watch.waiters.delete(waiter);
      // A nested call must not outlive the tool context that owns it.
      if (watch.prompt && watch.waiters.size === 0) {
        watch.prompt.controller.abort();
        await watch.prompt.done.catch(() => {});
      }
    }
  }

  private currentQuestion(status: Record<string, unknown>): Question | undefined {
    const questions = Array.isArray(status.questions) ? status.questions : [];
    return questions.filter(isRecord).find(q => typeof q.request_id === "string") as Question | undefined;
  }

  private async loop(watch: Watch): Promise<void> {
    const { ref } = watch;
    const signal = watch.controller.signal;
    while (!signal.aborted) {
      const status = await this.client.call("message_status", { ...ref }, signal);
      guard(() => this.ctx.ui.setStatus(`acp:${this.key(ref)}`, `ACP ${ref.message_id}: ${String(status.state)}`));
      const question = this.currentQuestion(status);
      if (watch.prompt && (status.terminal === true || question?.request_id !== watch.prompt.id)) {
        watch.prompt.controller.abort();
        await watch.prompt.done;
        watch.prompt = undefined;
      }
      if (status.terminal === true) {
        // The terminal `result` drives the final UI update, so the last preview is the settled answer.
        watch.preview = resultPreview(status);
        watch.result = status;
        // `onSettled` persists watch bookkeeping (`pi.appendEntry`), not presentation: a genuine
        // failure must surface through the watch error path rather than be swallowed by `guard`.
        this.onSettled(ref);
        // Presentation only; one waiter's throwing/async-rejecting renderer must not fail the rest.
        for (const waiter of watch.waiters) guard(() => waiter.update?.(status, watch.preview));
        for (const waiter of watch.waiters) waiter.resolve(status);
        if (watch.waiters.size === 0 && this.ctx.hasUI) {
          guard(() => this.ctx.ui.notify(`ACP ${ref.message_id}: ${String(status.state)}. Read with acp_message_status.`, status.state === "failed" ? "warning" : "info"));
        }
        return;
      }
      if (question && !watch.prompt && !watch.answered.has(question.request_id) && !watch.unhandled.has(question.request_id)) {
        const id = question.request_id;
        const controller = new AbortController();
        const done = (async () => {
          const active = watch.waiters.values().next().value as Waiter | undefined;
          const decision = await this.router.resolve(question, this.ctx, controller.signal, active?.ctx);
          if (controller.signal.aborted || signal.aborted) return;
          if (!decision) {
            watch.unhandled.add(id);
            // Non-interactive callers get waiting_input, so they can answer explicitly.
            for (const waiter of watch.waiters) waiter.resolve(status);
            return;
          }
          // Revalidate against the server immediately before answering a possibly stale UI.
          const current = await this.client.call("message_status", { ...ref }, signal);
          const still = this.currentQuestion(current);
          if (current.terminal === true || !still || still.request_id !== id) return;
          await this.client.call("answer_question", { ...ref, request_id: id, ...decision }, signal);
          watch.answered.add(id);
        })().catch(error => {
          if (controller.signal.aborted || signal.aborted) return;
          watch.unhandled.add(id);
          // The interaction failure is real: reject the waiters. Only the advisory notification is
          // presentation, so a throwing UI must not turn one failed answer into an unhandled error.
          for (const waiter of watch.waiters) waiter.reject(error);
          guard(() => this.ctx.ui.notify(`ACP interaction remains pending: ${String(error)}. Use acp_answer_question or retry acp_wait.`, "warning"));
        });
        watch.prompt = { id, controller, done };
        void done.finally(() => { if (watch.prompt?.controller === controller) watch.prompt = undefined; });
      }
      if (watch.waiters.size > 0) {
        // The UI-only preview is the current bounded progress snapshot, replaced (never appended).
        watch.preview = progressPreview(status);
        // A progress renderer is presentation: isolate each waiter so one bad update cannot stop
        // polling a still-running remote message or fail a sibling waiter.
        for (const waiter of watch.waiters) guard(() => waiter.update?.(status, watch.preview));
      }
      await delay(this.pollIntervalMs, undefined, { signal });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const watches = [...this.watches.values()];
    for (const watch of watches) {
      watch.controller.abort();
      watch.prompt?.controller.abort();
      for (const waiter of watch.waiters) waiter.reject(new Error("ACP session shut down"));
    }
    await Promise.all(watches.map(watch => watch.done));
  }
}
