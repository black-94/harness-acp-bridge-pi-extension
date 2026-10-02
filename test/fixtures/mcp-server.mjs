import { createInterface } from "node:readline";

const sessions = new Map();
const message = (sid) => sessions.get(sid);
const schema = (properties = {}, required = []) => ({ type: "object", properties, required });
const str = { type: "string", minLength: 1 };
const ref = { session_id: str, message_id: str };
const names = ["ping", "harness_info", "create_session", "authenticate", "auth_info", "set_model",
  "send_message", "message_result", "answer_question", "cancel_message", "live_output", "close_session"];
const tools = names.map(name => ({
  name, description: "Mock " + name,
  inputSchema: name === "send_message" ? schema({ session_id: str, text: str, mode: str, idempotency_key: str }, ["session_id", "text"])
    : name === "create_session" ? schema({ cwd: str, model_id: str }, ["cwd", "model_id"])
    : schema(ref),
}));
function call(name, args) {
  const sid = args.session_id;
  const current = message(sid);
  if (name === "ping") return { status: "ok" };
  if (name === "harness_info") return { harnesses: [{ name: "mock", models: [{ id: "fake-model" }] }] };
  if (name === "create_session") {
    const session_id = "session-" + (sessions.size + 1);
    sessions.set(session_id, { stage: "idle" });
    return { session_id, state: "ready" };
  }
  if (!current) throw { code: "unknown_session", message: "No such session" };
  if (name === "send_message") {
    if (!["idle", "completed", "cancelled"].includes(current.stage)) throw { code: "busy", message: "Session busy" };
    Object.assign(current, { stage: "permission", text: args.text, message_id: "msg-1" });
    return { message_id: current.message_id };
  }
  if (name === "message_result") {
    const terminal = ["completed", "cancelled"].includes(current.stage);
    return {
      state: terminal ? current.stage : "waiting_input", terminal, message_id: current.message_id,
      interaction: terminal ? null : current.stage === "permission"
        ? { request_id: "permission-1", permission: true, title: "Bash", message: "Run command?", raw_input: { command: "ls" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }], schema: null }
        : { request_id: "info-1", permission: false, title: "Name", message: "Provide a name", raw_input: {}, options: [],
            schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
      ...(terminal ? { text: "final:" + current.text, tool_calls: [], harness_session_id: "harness-1" } : {}),
    };
  }
  if (name === "live_output") return { chunk: args.offset ? "" : "working", next_offset: 7, stopped: current.stage === "completed" };
  if (name === "answer_question") {
    current.stage = current.text === "info" && current.stage === "permission" ? "information" : "completed";
    return { accepted: true };
  }
  if (name === "cancel_message") { current.stage = "cancelled"; return { state: "cancelled" }; }
  if (name === "close_session") { sessions.delete(sid); return { state: "closed" }; }
  return { status: "ok" };
}
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  if (frame.method === "initialize") return send(frame.id, {
    protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mock-bridge", version: "1" },
  });
  if (frame.method === "tools/list") return send(frame.id, { tools });
  if (frame.method === "tools/call") {
    let data;
    let isError = false;
    try { data = call(frame.params.name, frame.params.arguments ?? {}); }
    catch (error) { data = { status: "error", ...error }; isError = true; }
    return send(frame.id, { content: [{ type: "text", text: JSON.stringify(data) }], isError });
  }
  if (frame.method === "ping") return send(frame.id, {});
});
