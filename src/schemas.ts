/**
 * Static TypeBox schemas for the twelve `acp_` tools.
 *
 * These mirror the server's parameters exactly (including the `live_output`
 * `cursor`/`limit`/`wait_ms` protocol and `answer_question`'s string `request_id`). Unknown
 * parameters are rejected so a typo never silently loses a field.
 */
import { Type, type TSchema } from "typebox";

export type BridgeMethod =
  | "ping" | "search_harness" | "create_session" | "close_session" | "authenticate" | "auth_status"
  | "set_session_options" | "send_message" | "cancel_message" | "message_status" | "live_output" | "answer_question";

const strict = { additionalProperties: false } as const;
const permissionMode = Type.Union([Type.Literal("read"), Type.Literal("edit"), Type.Literal("auto"), Type.Literal("yolo")]);
const dockerMount = Type.Object({ source: Type.String({ minLength: 1 }), target: Type.String({ minLength: 1 }), read_only: Type.Optional(Type.Boolean()) }, strict);
const dockerPort = Type.Object({
  host_port: Type.Integer({ minimum: 1, maximum: 65535 }),
  container_port: Type.Integer({ minimum: 1, maximum: 65535 }),
  protocol: Type.Optional(Type.Union([Type.Literal("tcp"), Type.Literal("udp")])),
  host_ip: Type.Optional(Type.String({ minLength: 1 })),
}, strict);

const parameters: Record<BridgeMethod, TSchema> = {
  ping: Type.Object({}, strict),
  search_harness: Type.Object({ harness: Type.Optional(Type.String({ minLength: 1 })) }, strict),
  create_session: Type.Object({
    cwd: Type.String({ minLength: 1 }),
    model_id: Type.String({ minLength: 1 }),
    harness: Type.Optional(Type.String({ minLength: 1 })),
    thinking_level: Type.Optional(Type.String({ minLength: 1 })),
    permission_mode: Type.Optional(permissionMode),
    resume_session_id: Type.Optional(Type.String({ minLength: 1 })),
    authenticate: Type.Optional(Type.String({ minLength: 1 })),
    session_id: Type.Optional(Type.String({ minLength: 1 })),
    target: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
    remote_host: Type.Optional(Type.String({ minLength: 1 })),
    runtime: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("docker")])),
    container_policy: Type.Optional(Type.Union([Type.Literal("remove"), Type.Literal("keep")])),
    docker_id: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
    docker_image: Type.Optional(Type.String({ minLength: 1 })),
    mounts: Type.Optional(Type.Array(dockerMount)),
    ports: Type.Optional(Type.Array(dockerPort)),
    host_network: Type.Optional(Type.Boolean()),
  }, strict),
  close_session: Type.Object({ session_id: Type.String({ minLength: 1 }) }, strict),
  authenticate: Type.Object({ session_id: Type.String({ minLength: 1 }), method_id: Type.String({ minLength: 1 }) }, strict),
  auth_status: Type.Object({ session_id: Type.String({ minLength: 1 }) }, strict),
  set_session_options: Type.Object({
    session_id: Type.String({ minLength: 1 }),
    model_id: Type.Optional(Type.String({ minLength: 1 })),
    thinking_level: Type.Optional(Type.String({ minLength: 1 })),
    permission_mode: Type.Optional(permissionMode),
  }, strict),
  send_message: Type.Object({
    session_id: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    idempotency_key: Type.Optional(Type.String({ minLength: 1 })),
  }, strict),
  cancel_message: Type.Object({ session_id: Type.String({ minLength: 1 }), message_id: Type.String({ minLength: 1 }) }, strict),
  message_status: Type.Object({ session_id: Type.String({ minLength: 1 }), message_id: Type.String({ minLength: 1 }) }, strict),
  live_output: Type.Object({
    session_id: Type.String({ minLength: 1 }),
    message_id: Type.Optional(Type.String({ minLength: 1 })),
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })),
  }, strict),
  answer_question: Type.Object({
    session_id: Type.String({ minLength: 1 }),
    message_id: Type.String({ minLength: 1 }),
    request_id: Type.String({ minLength: 1 }),
    answer: Type.Optional(Type.Union([Type.Literal("accept"), Type.Literal("reject"), Type.Literal("timeout"), Type.Literal("cancel")])),
    option_id: Type.Optional(Type.String({ minLength: 1 })),
    content: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }, strict),
};

export interface ToolSpec {
  name: BridgeMethod;
  label: string;
  description: string;
  parameters: TSchema;
}

export const OUTPUT_SCHEMA = Type.Record(Type.String(), Type.Unknown());

export const TOOL_SPECS: ToolSpec[] = [
  { name: "ping", label: "ACP Ping", parameters: parameters.ping,
    description: "Check that the harness-acp-bridge server is reachable. Returns protocol version, PID, uptime, live session count, and configuration fingerprint. Starts no harness." },
  { name: "search_harness", label: "ACP Search Harness", parameters: parameters.search_harness,
    description: "List configured harnesses with models, declared thinking levels, and permission modes, from configuration only. Starts no harness." },
  { name: "create_session", label: "ACP Create Session", parameters: parameters.create_session,
    description: "Create a session-owned harness. cwd and model_id are required; optional harness, thinking_level, permission_mode and launch fields (target/runtime/docker/resume/authenticate). Returns the session snapshot including session_id." },
  { name: "close_session", label: "ACP Close Session", parameters: parameters.close_session,
    description: "Stop the harness and close the session. Repeated close is safe." },
  { name: "authenticate", label: "ACP Authenticate", parameters: parameters.authenticate,
    description: "Authenticate the child harness (its own login, not HTTP client auth) and open its session." },
  { name: "auth_status", label: "ACP Auth Status", parameters: parameters.auth_status,
    description: "Probe harness authentication. An unsupported probe fails with original details; unknown authentication is never guessed as logged out." },
  { name: "set_session_options", label: "ACP Set Session Options", parameters: parameters.set_session_options,
    description: "Change model_id, thinking_level, and/or permission_mode of an idle session. At least one option is required." },
  { name: "send_message", label: "ACP Send Message", parameters: parameters.send_message,
    description: "Submit a prompt to an ACP session and synchronously wait for its final result in the same tool call. Handles reverse permission/information requests with ask_user or native Pi dialogs, then resumes waiting; streams live preview updates. Aborting cancels the remote message. Without interactive UI it returns waiting_input for a manual acp_answer_question followed by acp_wait. Supports idempotency_key." },
  { name: "cancel_message", label: "ACP Cancel Message", parameters: parameters.cancel_message,
    description: "Request cancellation of the active message and wait for the original prompt to settle. An unconfirmed cancellation closes the session." },
  { name: "message_status", label: "ACP Message Status", parameters: parameters.message_status,
    description: "Return a message's state, terminal flag, pending questions, unsupported events, errors, and terminal result. Works after close or server restart." },
  { name: "live_output", label: "ACP Live Output", parameters: parameters.live_output,
    description: "Page through human-readable journal events with cursor/limit/wait_ms. Pass next_cursor back unchanged; always drain has_more even when terminal is true, and join complete:false fragments by seq/type." },
  { name: "answer_question", label: "ACP Answer Question", parameters: parameters.answer_question,
    description: "Answer a pending reverse request by its request_id. answer defaults to accept; permissions require an offered option_id, information/elicitation require an object content." },
];

export const WAIT_SCHEMA = Type.Object({
  session_id: Type.String({ minLength: 1 }),
  message_id: Type.String({ minLength: 1 }),
}, strict);
