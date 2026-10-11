import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { BridgeError, BridgeHttpClient } from "./client.ts";
import { isRecord, loadSettings } from "./config.ts";
import { InteractionRouter } from "./interactions.ts";
import { ServerLifecycle } from "./lifecycle.ts";
import { MessageMonitor, type MessageRef } from "./monitor.ts";
import { renderAcpResult } from "./render.ts";
import { OUTPUT_SCHEMA, TOOL_SPECS, WAIT_SCHEMA } from "./schemas.ts";

const watchEntry = "harness-acp-bridge-watch";

/** Final, model-facing result: the terminal message status only, never the UI preview. */
function toolResult(data: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  const full = JSON.stringify(data, null, 2);
  let text = full;
  if (full.length > 20_000) {
    const path = join(mkdtempSync(join(tmpdir(), "pi-acp-")), "result.json");
    writeFileSync(path, full, { mode: 0o600 });
    text = `${full.slice(0, 10_000)}\n… truncated …\n${full.slice(-8_000)}\nFull result: ${path}`;
  }
  const structuredContent = JSON.parse(full) as NonNullable<AgentToolResult<Record<string, unknown>>["structuredContent"]>;
  return { content: [{ type: "text" as const, text }], details: data, structuredContent };
}

/** UI-only progress update: empty content, preview in details, so it never enters the transcript. */
function previewUpdate(status: Record<string, unknown>, preview: string): AgentToolResult<Record<string, unknown>> {
  return { content: [], details: { state: status.state, preview } };
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
  let ctx: ExtensionContext | undefined;
  let initializing: Promise<void> | undefined;
  let ensured: Promise<void> | undefined;

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
        monitor = new MessageMonitor(client, new InteractionRouter(settings.interactionTimeoutMs), ctx!, settings.pollIntervalMs, ref => remember(ref, false));
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
  ) => {
    const result = await monitor!.wait(ref, toolCtx, signal, (status, preview) => {
      onUpdate?.(previewUpdate(status, preview));
    });
    return { ...toolResult({ ...result, ...ref }), ...(result.state === "failed" ? { isError: true } : {}) };
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
          const data = await client!.call("send_message", params, signal);
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
    pi.registerTool({
      name, label: tool.label, description: tool.description, parameters: tool.parameters, outputSchema: OUTPUT_SCHEMA,
      async execute(_id, args, signal) {
        await ensureServer();
        const data = await client!.call(tool.name, args as Record<string, unknown>, signal);
        return toolResult(data);
      },
    });
  }

  pi.registerTool({
    name: "acp_wait", label: "ACP Wait", description:
      "Wait for a previously submitted ACP bridge message by session_id/message_id. Handles reverse requests using ask_user or native dialogs and streams UI-only preview updates. Aborting cancels the remote message. Without interactive UI it returns waiting_input without inventing an answer; use acp_answer_question then acp_wait again.",
    parameters: WAIT_SCHEMA, outputSchema: OUTPUT_SCHEMA,
    renderResult: renderAcpResult,
    async execute(_id, ref, signal, onUpdate, toolCtx) {
      await ensureServer();
      return wait(ref as MessageRef, toolCtx, signal, onUpdate);
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
