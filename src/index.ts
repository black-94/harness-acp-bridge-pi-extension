import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { authenticateSession } from "./auth.ts";
import { BridgeError, BridgeHttpClient, errorInfo } from "./client.ts";
import { isRecord, loadSettings } from "./config.ts";
import { InteractionRouter } from "./interactions.ts";
import { ServerLifecycle } from "./lifecycle.ts";
import { MessageMonitor, type MessageRef } from "./monitor.ts";
import { collectSecrets, redactValue } from "./redact.mjs";
import { renderAcpResult } from "./render.ts";
import { OUTPUT_SCHEMA, TOOL_SPECS, WAIT_SCHEMA } from "./schemas.ts";

const watchEntry = "harness-acp-bridge-watch";

/** Structured, model-readable envelope for a failed bridge call. */
function errorEnvelope(error: unknown): Record<string, unknown> {
  return { ok: false, error: errorInfo(error) };
}

/** Final, model-facing result: the terminal message status only, never the UI preview. */
function toolResult(data: Record<string, unknown>, secrets: readonly string[]): AgentToolResult<Record<string, unknown>> {
  const full = JSON.stringify(data, null, 2);
  let text = full;
  if (full.length > 20_000) {
    const path = join(mkdtempSync(join(tmpdir(), "pi-acp-")), "result.json");
    // Only the persisted copy is sanitized: recursive sensitive-key masking, textual credential
    // patterns, and known sensitive env literals. The returned context keeps the real business
    // response (policy permits the raw HTTP body in memory); the preview never appears here.
    writeFileSync(path, `${JSON.stringify(redactValue(data, secrets), null, 2)}\n`, { mode: 0o600 });
    text = `${full.slice(0, 10_000)}\n… truncated …\n${full.slice(-8_000)}\nFull result: ${path}`;
  }
  const structuredContent = JSON.parse(full) as NonNullable<AgentToolResult<Record<string, unknown>>["structuredContent"]>;
  return { content: [{ type: "text" as const, text }], details: data, structuredContent };
}

/**
 * A unified authentication failure, kept model-readable.
 *
 * The server returns `authentication_required` with detail
 * `{ session_id, next_action: { method: "authenticate", params: { session_id } } }`. Throwing an
 * `Error` would collapse that to its message, losing the `session_id` the model needs (especially
 * after `create_session`). Returning an `isError` result instead preserves the full structured
 * envelope for both the model-facing text and `structuredContent`, and never auto-authenticates.
 */
function authRequiredResult(error: unknown): AgentToolResult<Record<string, unknown>> {
  const envelope = errorEnvelope(error);
  const full = JSON.stringify(envelope, null, 2);
  return {
    isError: true,
    content: [{ type: "text" as const, text: full }],
    details: envelope,
    structuredContent: envelope as NonNullable<AgentToolResult<Record<string, unknown>>["structuredContent"]>,
  };
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof BridgeError && error.code === "authentication_required";
}

/**
 * A terminal status is reported to the model as a tool error when the turn failed OR carries an
 * `error` object (e.g. `cancelled`/`input_timeout`, or an `authentication_rate_limited` flow). A
 * plain user cancel with no error is a normal terminal result. The full status — including
 * `state` and `error` — is always preserved in `content`/`details`/`structuredContent`.
 */
function isErrorStatus(status: Record<string, unknown>): boolean {
  return status.terminal === true && (status.state === "failed" || isRecord(status.error));
}

/**
 * UI-only progress update: never enters the transcript, and never carries preview text.
 *
 * `content` is a single empty text block instead of `[]`, and `structuredContent` is present
 * (empty): host and third-party tool bridges commonly assume a partial result has a text block
 * and structured data (`partialResult.content[0].text.length`,
 * `JSON.stringify(partialResult.structuredContent).length`). An empty array or a missing
 * `structuredContent` makes those readers throw a `TypeError` that the host attributes to the
 * tool call, while the remote message keeps running. The rolling preview lives only in
 * `details.preview` for the renderer; it is never in `content` or `structuredContent`.
 *
 * `details.activity` is a small, sanitized projection of the server's status metrics (phase,
 * elapsed-since-progress, stall hint). It is UI-only metadata, never preview text.
 */
function previewUpdate(status: Record<string, unknown>, preview: string): AgentToolResult<Record<string, unknown>> {
  const activity = activityDetails(status);
  return {
    content: [{ type: "text" as const, text: "" }],
    details: {
      state: status.state,
      preview,
      // The message id belongs to the result, not to the activity metrics, so it is present even
      // when no activity is reported. The renderer reads `details.message_id`.
      ...(typeof status.message_id === "string" ? { message_id: status.message_id } : {}),
      ...(activity ? { activity } : {}),
    },
    structuredContent: {},
  };
}

/** Copy only whitelisted, non-preview **activity** fields (never `message_id`) into `details.activity`. */
function activityDetails(status: Record<string, unknown>): Record<string, unknown> | undefined {
  const activity = isRecord(status.activity) ? status.activity : undefined;
  if (!activity) return undefined;
  const picked: Record<string, unknown> = {};
  // Keep the server's field name so server, renderer, and docs agree.
  if (typeof activity.observed_phase === "string") picked.observed_phase = activity.observed_phase;
  if (typeof activity.seconds_since_progress === "number") picked.seconds_since_progress = activity.seconds_since_progress;
  if (typeof activity.last_progress_at === "string") picked.last_progress_at = activity.last_progress_at;
  if (typeof activity.stalled === "boolean") picked.stalled = activity.stalled;
  if (typeof activity.stall_hint_seconds === "number") picked.stall_hint_seconds = activity.stall_hint_seconds;
  return Object.keys(picked).length ? picked : undefined;
}

/**
 * Pi tools over the harness-acp-bridge HTTP server.
 *
 * A thin client plus a managed local-server lifecycle. `acp_send_message` synchronously waits
 * for the terminal result in the same tool call, with UI-only preview updates; the final
 * content and structured result are the terminal message status, never the preview. It never
 * starts a harness directly and never auto-approves a permission.
 */
export default function acpBridgeExtension(pi: ExtensionAPI): void {
  let client: BridgeHttpClient | undefined;
  let lifecycle: ServerLifecycle | undefined;
  let monitor: MessageMonitor | undefined;
  let router: InteractionRouter | undefined;
  let pollIntervalMs = 500;
  let ctx: ExtensionContext | undefined;
  let initializing: Promise<void> | undefined;
  let ensured: Promise<void> | undefined;
  // Literal secret values from sensitive-named env keys, masked wherever they appear in a
  // persisted oversized result. Kept in memory only, never written.
  const secrets = collectSecrets(process.env);

  const remember = (ref: MessageRef, active: boolean): void => pi.appendEntry(watchEntry, { ...ref, active });
  const startWatch = (ref: MessageRef): void => {
    if (!monitor) throw new Error("ACP bridge is not initialized");
    remember(ref, true);
    monitor.start(ref);
  };

  async function ensureConnected(): Promise<void> {
    if (!ctx) throw new Error("ACP bridge requires a running Pi session");
    if (initializing) return initializing;
    initializing = (async () => {
      if (!client) {
        const settings = loadSettings(ctx!.cwd);
        client = new BridgeHttpClient(settings);
        lifecycle = new ServerLifecycle(settings, process.env, ctx!.cwd);
        router = new InteractionRouter(settings.interactionTimeoutMs);
        pollIntervalMs = settings.pollIntervalMs;
        monitor = new MessageMonitor(client, router, ctx!, settings.pollIntervalMs, ref => remember(ref, false));
      }
    })().finally(() => { initializing = undefined; });
    return initializing;
  }

  /** Reuse or start the local server once; allow a retry after a failure. */
  async function ensureServer(): Promise<void> {
    await ensureConnected();
    if (!ensured) ensured = lifecycle!.ensure().then(() => undefined).catch(error => { ensured = undefined; throw error; });
    return ensured;
  }

  const wait = async (
    ref: MessageRef,
    toolCtx: ExtensionToolContext,
    signal: AbortSignal | undefined,
    onUpdate: ((result: AgentToolResult<Record<string, unknown>>) => void) | undefined,
    cancelOnAbort = true,
  ) => {
    const result = await monitor!.wait(ref, toolCtx, signal, (status, preview) => {
      // Return the host callback's value (possibly a promise) so the monitor's presentation guard
      // can attach to a rejection; otherwise an async-rejecting onUpdate becomes unhandled.
      return onUpdate?.(previewUpdate(status, preview));
    }, { cancelOnAbort });
    return { ...toolResult({ ...result, ...ref }, secrets), ...(isErrorStatus(result) ? { isError: true } : {}) };
  };

  for (const tool of TOOL_SPECS) {
    const name = `acp_${tool.name}`;
    if (tool.name === "send_message") {
      pi.registerTool({
        name, label: tool.label, description: tool.description, parameters: tool.parameters, outputSchema: OUTPUT_SCHEMA,
        renderResult: renderAcpResult,
        async execute(_id, args, signal, onUpdate, toolCtx) {
          await ensureServer();
          const params = args as Record<string, unknown>;
          let data: Record<string, unknown>;
          try {
            data = await client!.call("send_message", params, signal);
          } catch (error) {
            if (isAuthRequired(error)) return authRequiredResult(error);
            throw error;
          }
          if (typeof params.session_id !== "string" || typeof data.message_id !== "string") {
            throw new BridgeError("invalid_result", "send_message returned no valid message reference");
          }
          const ref: MessageRef = { session_id: params.session_id, message_id: data.message_id };
          startWatch(ref);
          return wait(ref, toolCtx, signal, onUpdate);
        },
      });
      continue;
    }
    if (tool.name === "authenticate") {
      // The tool itself drives the interactive authentication workflow: it asks every
      // server-provided question through the router (never choosing a method or a token for the
      // user), sends each answer as a session-scoped answer_question, and polls to a terminal
      // state. Aborting only detaches the local wait.
      pi.registerTool({
        name, label: tool.label, description: tool.description, parameters: tool.parameters, outputSchema: OUTPUT_SCHEMA,
        async execute(_id, args, signal, _onUpdate, toolCtx) {
          await ensureServer();
          const params = args as Record<string, unknown>;
          if (typeof params.session_id !== "string") throw new BridgeError("invalid_param", "session_id is required");
          const status = await authenticateSession(
            client!, router!, { session_id: params.session_id }, ctx!, toolCtx,
            signal ?? new AbortController().signal, pollIntervalMs,
          );
          return { ...toolResult(status, secrets), ...(isErrorStatus(status) ? { isError: true } : {}) };
        },
      });
      continue;
    }
    pi.registerTool({
      name, label: tool.label, description: tool.description, parameters: tool.parameters, outputSchema: OUTPUT_SCHEMA,
      async execute(_id, args, signal) {
        await ensureServer();
        try {
          const data = await client!.call(tool.name, args as Record<string, unknown>, signal);
          return toolResult(data, secrets);
        } catch (error) {
          if (isAuthRequired(error)) return authRequiredResult(error);
          throw error;
        }
      },
    });
  }

  pi.registerTool({
    name: "acp_wait", label: "ACP Wait", description:
      "Wait for a previously submitted ACP bridge message by session_id/message_id. Handles reverse requests using ask_user or native dialogs and renders status.progress as a UI-only preview. Aborting only stops local waiting and leaves the remote message running; another acp_wait can resume it. Without interactive UI it returns waiting_input without inventing an answer; use acp_answer_question then acp_wait again.",
    parameters: WAIT_SCHEMA, outputSchema: OUTPUT_SCHEMA,
    renderResult: renderAcpResult,
    async execute(_id, ref, signal, onUpdate, toolCtx) {
      await ensureServer();
      return wait(ref as MessageRef, toolCtx, signal, onUpdate, false);
    },
  });

  pi.registerCommand("acp-connect", {
    description: "Connect to harness-acp-bridge, starting a local server if necessary, and verify it is reachable",
    async handler(_args, commandCtx) {
      ctx = commandCtx;
      try { await ensureServer(); commandCtx.ui.notify("ACP bridge connected", "info"); }
      catch (error) { commandCtx.ui.notify(`ACP bridge: ${String(error)}`, "error"); }
    },
  });

  pi.on("session_start", async (_event, sessionCtx) => {
    ctx = sessionCtx;
    try {
      await ensureServer();
      // Only restore this branch; never start harnesses or close remote sessions implicitly.
      const pending = new Map<string, MessageRef>();
      for (const entry of sessionCtx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== watchEntry || !isRecord(entry.data)) continue;
        const { session_id, message_id, active } = entry.data;
        if (typeof session_id !== "string" || typeof message_id !== "string") continue;
        const key = JSON.stringify([session_id, message_id]);
        if (active === true) pending.set(key, { session_id, message_id });
        else pending.delete(key);
      }
      for (const ref of pending.values()) monitor!.start(ref);
    } catch (error) {
      sessionCtx.ui.notify(`ACP bridge unavailable: ${String(error)}. Check that the server is running at the configured baseUrl; use /acp-connect to retry.`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    await monitor?.stop();
    monitor = undefined;
    client = undefined;
    lifecycle = undefined;
    ensured = undefined;
    ctx = undefined;
  });
}
