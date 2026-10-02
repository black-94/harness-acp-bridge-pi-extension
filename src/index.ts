import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { BridgeClient, BridgeError } from "./client.ts";
import { isRecord, loadSettings } from "./config.ts";
import { InteractionRouter } from "./interactions.ts";
import { MessageMonitor, type MessageRef } from "./monitor.ts";

const watchEntry = "harness-acp-bridge-watch";
const refSchema = Type.Object({ session_id: Type.String({ minLength: 1 }), message_id: Type.String({ minLength: 1 }) });
const outputSchema = Type.Record(Type.String(), Type.Unknown());

function toolResult(data: Record<string, unknown>) {
  const full = JSON.stringify(data, null, 2);
  let text = full;
  if (full.length > 20_000) {
    const path = join(mkdtempSync(join(tmpdir(), "pi-acp-")), "result.json");
    writeFileSync(path, full, { mode: 0o600 });
    text = `${full.slice(0, 10_000)}\n… truncated …\n${full.slice(-8_000)}\nFull result: ${path}`;
  }
  const structuredContent = JSON.parse(full) as NonNullable<AgentToolResult["structuredContent"]>;
  return { content: [{ type: "text" as const, text }], details: data, structuredContent };
}

/** Entry point: resources start only after session_start and are released at shutdown. */
export default function acpBridgeExtension(pi: ExtensionAPI) {
  let client: BridgeClient | undefined;
  let monitor: MessageMonitor | undefined;
  let ctx: ExtensionContext | undefined;
  let initializing: Promise<void> | undefined;
  const registered = new Set<string>();
  const signatures = new Map<string, string>();

  const remember = (ref: MessageRef, active: boolean) => pi.appendEntry(watchEntry, { ...ref, active });
  const startWatch = (ref: MessageRef) => {
    if (!monitor) throw new Error("ACP bridge is not initialized");
    remember(ref, true);
    monitor.start(ref);
  };

  const registerProxy = (tool: Tool) => {
    const name = `acp_${tool.name}`;
    const signature = JSON.stringify(tool);
    if (signatures.get(name) === signature) return;
    signatures.set(name, signature);
    const defaultActive = !registered.has(name) || pi.getActiveTools().includes(name);
    registered.add(name);
    pi.registerTool({
      defaultActive,
      name, label: `ACP ${tool.title ?? tool.name}`,
      description: tool.name === "send_message"
        ? "Submit a prompt to an ACP session and synchronously wait for its final result. Handles reverse permission/information requests inside this tool execution with ask_user or native Pi dialogs, then resumes waiting. Streams preview updates; abort cancels the remote message. With no UI, returns waiting_input for manual answering. Supports the server mode/idempotency_key contract."
        : `${tool.description ?? tool.name}\nThin proxy to harness-acp-bridge.`,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      outputSchema,
      namespace: { name: "acp", description: "ACP harness bridge sessions and message operations" },
      annotations: tool.annotations,
      async execute(_id, args, signal, onUpdate, toolCtx) {
        await ensureConnected();
        const data = await client!.call(tool.name, args, signal);
        if (tool.name === "send_message") {
          if (typeof args.session_id !== "string" || typeof data.message_id !== "string") {
            throw new BridgeError("invalid_result", "send_message returned no valid message reference");
          }
          const ref = { session_id: args.session_id, message_id: data.message_id };
          startWatch(ref);
          return wait(ref, toolCtx, signal, onUpdate);
        }
        return toolResult(data);
      },
    });
  };

  async function ensureConnected(): Promise<void> {
    if (!ctx) throw new Error("ACP bridge requires a running Pi session");
    if (initializing) return initializing;
    initializing = (async () => {
      if (!client) {
        const settings = loadSettings(ctx!.cwd);
        client = new BridgeClient(settings);
        monitor = new MessageMonitor(client, new InteractionRouter(settings.interactionTimeoutMs), ctx!, settings.pollIntervalMs, ref => remember(ref, false));
      }
      const tools = await client.connect();
      const available = new Set(tools.map(tool => `acp_${tool.name}`));
      for (const name of registered) {
        if (!available.has(name)) {
          signatures.delete(name);
          pi.registerTool({
            name, label: name, description: "Withdrawn bridge tool", parameters: Type.Object({}), exposure: "hidden",
            async execute() { throw new Error("Bridge tool is no longer available"); },
          });
        }
      }
      // Preserve explicit tool activation/deactivation on reconnect.
      for (const tool of tools) registerProxy(tool);
    })().finally(() => { initializing = undefined; });
    return initializing;
  }

  const wait = async (ref: MessageRef, toolCtx: ExtensionToolContext, signal: AbortSignal | undefined, onUpdate: ((result: ReturnType<typeof toolResult>) => void) | undefined) => {
    const result = await monitor!.wait(ref, toolCtx, signal, (status, preview) => {
      onUpdate?.(toolResult({ ...status, preview }));
    });
    return { ...toolResult({ ...result, ...ref }), ...(result.state === "failed" ? { isError: true } : {}) };
  };

  pi.registerTool({
    name: "acp_wait", label: "ACP Wait",
    description: "Wait for a previously submitted ACP bridge message. Handles reverse requests using ask_user when callable, falling back to native dialogs, and streams preview updates. Aborting cancels the remote message. Without interactive UI, returns waiting_input without inventing an answer; use acp_answer_question then acp_wait again.",
    parameters: refSchema, outputSchema,
    async execute(_id, ref, signal, onUpdate, toolCtx) {
      await ensureConnected();
      return wait(ref, toolCtx, signal, onUpdate);
    },
  });

  pi.registerCommand("acp-connect", {
    description: "Connect to harness-acp-bridge and discover its tools (retry after startup errors)",
    async handler(_args, commandCtx) {
      ctx = commandCtx;
      try { await ensureConnected(); commandCtx.ui.notify("ACP bridge connected", "info"); }
      catch (error) { commandCtx.ui.notify(`ACP bridge: ${String(error)}`, "error"); }
    },
  });

  pi.on("session_start", async (_event, sessionCtx) => {
    ctx = sessionCtx;
    try {
      await ensureConnected();
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
      sessionCtx.ui.notify(`ACP bridge unavailable: ${String(error)}. Configure harness-acp-bridge.json or HARNESS_ACP_BRIDGE_SERVER, then /acp-connect.`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    await monitor?.stop();
    await client?.close();
    monitor = undefined;
    client = undefined;
    ctx = undefined;
  });
}
