import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { BridgeConnection } from "./client.ts";
import { isRecord } from "./config.ts";
import { InteractionRouter, type Interaction } from "./interactions.ts";

export interface MessageRef { session_id: string; message_id: string }
interface Waiter {
  ctx: ExtensionToolContext;
  update?: (status: Record<string, unknown>, preview: string) => void;
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
  offset?: number;
  lastStatus?: Record<string, unknown>;
  prompt?: { id: string; controller: AbortController; done: Promise<void> };
  answered: Set<string>;
  unhandled: Set<string>;
}

/** Polling is authoritative. MCP completion log messages are advisory only. */
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
      if (!this.stopped && watch.waiters.size === 0) this.ctx.ui.notify(`ACP monitor: ${String(error)}`, "warning");
    }).finally(async () => {
      watch.prompt?.controller.abort();
      await watch.prompt?.done.catch(() => {});
      this.ctx.ui.setStatus(`acp:${key}`, undefined);
      this.watches.delete(key);
    });
    return watch;
  }

  async wait(ref: MessageRef, ctx: ExtensionToolContext, signal?: AbortSignal, update?: Waiter["update"]): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
      await this.client.call("cancel_message", { ...ref });
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
    const abort = () => {
      watch.prompt?.controller.abort();
      waiter.reject(signal?.reason ?? new Error("ACP wait aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { return await result; }
    catch (error) {
      if (signal?.aborted && !this.stopped) {
        // Tool cancellation cancels the remote message, not just the local polling call.
        await this.client.call("cancel_message", { ...ref }).catch(cancelError => {
          this.ctx.ui.notify(`ACP cancellation failed; message may still be running: ${String(cancelError)}`, "warning");
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

  private async loop(watch: Watch): Promise<void> {
    const { ref } = watch;
    const signal = watch.controller.signal;
    while (!signal.aborted) {
      const status = await this.client.call("message_result", { ...ref }, signal);
      watch.lastStatus = status;
      this.ctx.ui.setStatus(`acp:${this.key(ref)}`, `ACP ${ref.message_id}: ${String(status.state)}`);
      const interaction = isRecord(status.interaction) ? status.interaction : undefined;
      if (watch.prompt && (status.terminal === true || interaction?.request_id !== watch.prompt.id)) {
        watch.prompt.controller.abort();
        await watch.prompt.done;
        watch.prompt = undefined;
      }
      if (status.terminal === true) {
        watch.result = status;
        this.onSettled(ref);
        for (const waiter of watch.waiters) waiter.resolve(status);
        if (watch.waiters.size === 0 && this.ctx.hasUI) {
          this.ctx.ui.notify(`ACP ${ref.message_id}: ${String(status.state)}. Read with acp_message_result.`, status.state === "failed" ? "warning" : "info");
        }
        return;
      }
      if (interaction && typeof interaction.request_id === "string" && !watch.prompt
        && !watch.answered.has(interaction.request_id) && !watch.unhandled.has(interaction.request_id)) {
        const id = interaction.request_id;
        const controller = new AbortController();
        const done = (async () => {
          const active = watch.waiters.values().next().value as Waiter | undefined;
          const decision = await this.router.resolve(interaction as unknown as Interaction, this.ctx, controller.signal, active?.ctx);
          if (controller.signal.aborted || signal.aborted) return;
          if (!decision) {
            watch.unhandled.add(id);
            // Non-interactive callers get waiting_input, so they can answer explicitly.
            for (const waiter of watch.waiters) waiter.resolve(status);
            return;
          }
          // Revalidate against the server immediately before answering a possibly stale UI.
          const current = await this.client.call("message_result", { ...ref }, signal);
          if (current.terminal === true || !isRecord(current.interaction) || current.interaction.request_id !== id) return;
          await this.client.call("answer_question", { ...ref, request_id: id, ...decision }, signal);
          watch.answered.add(id);
        })().catch(error => {
          if (controller.signal.aborted || signal.aborted) return;
          watch.unhandled.add(id);
          for (const waiter of watch.waiters) waiter.reject(error);
          this.ctx.ui.notify(`ACP interaction remains pending: ${String(error)}. Use acp_answer_question or retry acp_wait.`, "warning");
        });
        watch.prompt = { id, controller, done };
        void done.finally(() => { if (watch.prompt?.controller === controller) watch.prompt = undefined; });
      }
      if (watch.waiters.size > 0) {
        const output = await this.client.call("live_output", {
          ...ref, ...(watch.offset === undefined ? {} : { offset: watch.offset }), max_bytes: 16_384,
        }, signal);
        if (typeof output.next_offset === "number") watch.offset = output.next_offset;
        if (typeof output.chunk === "string") watch.preview = (watch.preview + output.chunk).slice(-16_384);
        for (const waiter of watch.waiters) waiter.update?.(status, watch.preview);
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
