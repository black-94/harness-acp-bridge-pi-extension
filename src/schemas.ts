/**
 * Static TypeBox schemas for the `acp_` tools.
 *
 * These mirror the server's parameters exactly. Unknown parameters are rejected so a typo never
 * silently loses a field. A tool's `name` is model-facing; its optional `method` is the server
 * HTTP method it calls (`acp_create_template` → `register_template`). Together with the exported
 * JSON schema the model sees, they stay consistent: `acp_create_session` requires `cwd` and
 * `model_id` and never accepts a `template`.
 */
import { Type, type TSchema } from "typebox";

export type BridgeMethod =
  | "ping" | "search_template" | "create_template" | "create_session" | "close_session"
  | "authenticate" | "auth_status" | "set_session_options" | "send_message" | "cancel_message"
  | "message_status" | "answer_question";

/**
 * Server HTTP methods the tools call. Tool names equal methods except `acp_create_template`, which
 * is a client alias for the server's `register_template` (there is no `POST /api/create_template`).
 */
export type BridgeHttpMethod = Exclude<BridgeMethod, "create_template"> | "register_template";

const strict = { additionalProperties: false } as const;
/** JSON Schema pattern that rejects an embedded NUL (U+0000) in a caller string. */
const noNul = "^[^\\u0000]*$";
const proxyEnvKeys = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
const noHostProxy = { not: { required: ["host_network", "env"], properties: {
  host_network: { const: true }, env: { anyOf: proxyEnvKeys.map(key => ({
    required: [key], properties: { [key]: { type: "string", pattern: "\\S" } },
  })) },
} } };
const templateNetworkRules = [
  { if: { required: ["network_mode"], properties: { network_mode: { enum: ["host", "proxy"] } } },
    then: { required: ["runtime"], properties: { runtime: { const: "docker" } } } },
  { if: { required: ["network_mode"], properties: { network_mode: { const: "proxy" } } },
    then: { required: ["proxy_port"], properties: { proxy_port: { type: "integer", minimum: 1, maximum: 65535 } } } },
  { if: { not: { required: ["network_mode"], properties: { network_mode: { const: "proxy" } } } },
    then: { properties: { proxy_port: { type: "null" } } } },
  { if: { required: ["runtime"], properties: { runtime: { const: "docker" } },
      not: { required: ["network_mode"], properties: { network_mode: { const: "proxy" } } } },
    then: { not: { required: ["env"], properties: { env: { anyOf: proxyEnvKeys.map(key => ({
      required: [key], properties: { [key]: { type: "string", pattern: "\\S" } },
    })) } } } } },
  { if: { required: ["network_mode"], properties: { network_mode: { const: "host" } } },
    then: { not: { required: ["ports"], properties: { ports: { minItems: 1 } } } } },
];
const permissionMode = Type.Union([Type.Literal("read"), Type.Literal("edit"), Type.Literal("auto"), Type.Literal("yolo")]);
const dockerMount = Type.Object({ source: Type.String({ minLength: 1, pattern: noNul }), target: Type.String({ minLength: 1, pattern: noNul }), read_only: Type.Optional(Type.Boolean()) }, strict);
const dockerPort = Type.Object({
  host_port: Type.Integer({ minimum: 1, maximum: 65535 }),
  container_port: Type.Integer({ minimum: 1, maximum: 65535 }),
  protocol: Type.Optional(Type.Union([Type.Literal("tcp"), Type.Literal("udp")])),
  // Nullable to match the server contract: a searched template's `host_ip: null` can be expanded.
  host_ip: Type.Optional(Type.Union([Type.String({ minLength: 1, pattern: noNul }), Type.Null()])),
}, strict);
/**
 * A template's port. The server's template schema stores `host_ip` as nullable/default null, so a
 * template returned by a search (with `host_ip: null`) can be re-registered as-is; create_session
 * accepts the same nullable shape so a template can be expanded into session parameters unchanged.
 */
const templatePort = Type.Object({
  host_port: Type.Integer({ minimum: 1, maximum: 65535 }),
  container_port: Type.Integer({ minimum: 1, maximum: 65535 }),
  protocol: Type.Optional(Type.Union([Type.Literal("tcp"), Type.Literal("udp")])),
  host_ip: Type.Optional(Type.Union([Type.String({ minLength: 1, pattern: noNul }), Type.Null()])),
}, strict);

/**
 * A launch template as accepted by `register_template` (`acp_create_template`). Only fields the
 * server can register are allowed; `name` and `harness` are required and everything else is
 * optional (the server applies defaults). The server rejects a duplicate name rather than
 * overwriting, and validates argv without starting the harness.
 */
const launchTemplate = Type.Object({
  name: Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" }),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  harness: Type.Union([Type.Literal("codebuddy"), Type.Literal("codex"), Type.Literal("agy")]),
  model: Type.Optional(Type.Union([Type.String({ minLength: 1, pattern: "^(?!\\s*$)[^\\u0000]+$", description: "Default model_id for create_session; not a candidate list." }), Type.Null()])),
  thinking: Type.Optional(Type.Union([Type.String({ minLength: 1, pattern: "^(?!\\s*$)[^\\u0000]+$", description: "Default thinking_level for create_session; validated by the live harness." }), Type.Null()])),
  before_start: Type.Optional(Type.Union([Type.String({ pattern: noNul, description: "Natural-language actions for the calling LLM before ACP startup; never a server hook." }), Type.Null()])),
  after_start: Type.Optional(Type.Union([Type.String({ pattern: noNul, description: "Natural-language actions for the calling LLM after startup; never a server hook." }), Type.Null()])),
  special_instructions: Type.Optional(Type.Union([Type.String({ pattern: noNul, description: "Natural-language guidance for the calling LLM throughout the workflow." }), Type.Null()])),
  runtime: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("docker")])),
  target: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
  remote_host: Type.Optional(Type.Union([Type.String({ pattern: noNul }), Type.Null()])),
  permission_mode: Type.Optional(permissionMode),
  command: Type.Optional(Type.Union([Type.String({ pattern: noNul }), Type.Null()])),
  args: Type.Optional(Type.Array(Type.String({ pattern: noNul }))),
  env: Type.Optional(Type.Record(Type.String({ pattern: noNul }), Type.String({ pattern: noNul }))),
  cwd: Type.Optional(Type.Union([Type.String({ pattern: noNul }), Type.Null()])),
  docker_image: Type.Optional(Type.Union([Type.String({ pattern: noNul }), Type.Null()])),
  container_policy: Type.Optional(Type.Union([Type.Literal("remove"), Type.Literal("keep")])),
  login_dirs: Type.Optional(Type.Array(dockerMount)),
  mounts: Type.Optional(Type.Array(dockerMount)),
  ports: Type.Optional(Type.Array(templatePort)),
  network_mode: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("host"), Type.Literal("proxy")], {
    description: "Docker networking, default none. host maps to session host_network=true; proxy requires proxy_port and generates http_proxy/https_proxy/no_proxy in env. Not a create_session field.",
  })),
  proxy_port: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 65535,
    description: "Host HTTP proxy port for network_mode=proxy. Generates identical http_proxy/https_proxy at http://host.docker.internal:PORT and no_proxy for common private ranges." }), Type.Null()])),
}, { ...strict, allOf: templateNetworkRules });

/**
 * `create_session` fields. `cwd` and `model_id` are always required and there is no `template`
 * parameter: a session is a direct call. The launch executable/argv/environment (`command`/`args`/
 * `env`) and Docker-only `login_dirs` are direct session parameters. `command` may be empty/null
 * (built-in executable), so it has no `minLength`.
 */
const createSessionBase = {
  model_id: Type.String({ minLength: 1, pattern: noNul }),
  harness: Type.Optional(Type.String({ minLength: 1, pattern: noNul })),
  command: Type.Optional(Type.Union([Type.String({ pattern: noNul }), Type.Null()])),
  args: Type.Optional(Type.Array(Type.String({ pattern: noNul }))),
  env: Type.Optional(Type.Record(Type.String({ pattern: noNul }), Type.String({ pattern: noNul }))),
  thinking_level: Type.Optional(Type.String({ minLength: 1, pattern: noNul })),
  permission_mode: Type.Optional(permissionMode),
  resume_session_id: Type.Optional(Type.String({ minLength: 1, pattern: noNul })),
  session_id: Type.Optional(Type.String({ minLength: 1, pattern: noNul })),
  target: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
  remote_host: Type.Optional(Type.String({ minLength: 1, pattern: noNul })),
  runtime: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("docker")])),
  // Nullable so a template's neutral defaults (null/[]/false) can be expanded unchanged.
  container_policy: Type.Optional(Type.Union([Type.Literal("remove"), Type.Literal("keep"), Type.Null()])),
  docker_id: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  docker_image: Type.Optional(Type.Union([Type.String({ minLength: 1, pattern: noNul }), Type.Null()])),
  login_dirs: Type.Optional(Type.Array(dockerMount)),
  mounts: Type.Optional(Type.Array(dockerMount)),
  ports: Type.Optional(Type.Array(dockerPort)),
  host_network: Type.Optional(Type.Boolean()),
} as const;

/**
 * A single JSON object (not a root `anyOf`/union): some model providers only accept an object with
 * `type`/`properties` at the root. `cwd` and `model_id` are required, there is no `template`
 * parameter, and the object-level `allOf` conditions enforce the cross-field rules (also enforced
 * server-side): published ports exclude host networking, a reused container fixes its own Docker
 * fields, and a direct runtime rejects *effective* Docker options while accepting neutral defaults.
 */
const createSession = Type.Object({
  ...createSessionBase,
  cwd: Type.String({ minLength: 1, pattern: noNul }),
}, {
  ...strict,
  allOf: [
    { not: { required: ["host_network", "ports"], properties: { host_network: { const: true }, ports: { minItems: 1 } } } },
    noHostProxy,
    { not: { required: ["docker_id"], anyOf: [
      { required: ["docker_image"], properties: { docker_image: { type: "string" } } },
      { required: ["login_dirs"], properties: { login_dirs: { minItems: 1 } } },
      { required: ["mounts"], properties: { mounts: { minItems: 1 } } },
      { required: ["ports"], properties: { ports: { minItems: 1 } } },
      { required: ["host_network"], properties: { host_network: { const: true } } },
    ] } },
    { if: { not: { required: ["runtime"], properties: { runtime: { const: "docker" } } } },
      then: { not: { anyOf: [
        { required: ["docker_image"], properties: { docker_image: { type: "string" } } },
        { required: ["docker_id"] },
        { required: ["container_policy"], properties: { container_policy: { type: "string" } } },
        { required: ["login_dirs"], properties: { login_dirs: { minItems: 1 } } },
        { required: ["mounts"], properties: { mounts: { minItems: 1 } } },
        { required: ["ports"], properties: { ports: { minItems: 1 } } },
        { required: ["host_network"], properties: { host_network: { const: true } } },
      ] } } },
  ],
});

const parameters: Record<BridgeMethod, TSchema> = {
  ping: Type.Object({}, strict),
  search_template: Type.Object({
    name: Type.Optional(Type.String({ minLength: 1 })),
    query: Type.Optional(Type.String({ minLength: 1 })),
    harness: Type.Optional(Type.String({ minLength: 1 })),
  }, strict),
  create_template: Type.Object({ template: launchTemplate }, strict),
  create_session: createSession,
  close_session: Type.Object({ session_id: Type.String({ minLength: 1 }) }, strict),
  authenticate: Type.Object({ session_id: Type.String({ minLength: 1 }) }, strict),
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
  answer_question: Type.Object({
    session_id: Type.String({ minLength: 1 }),
    message_id: Type.Optional(Type.String({ minLength: 1 })),
    request_id: Type.String({ minLength: 1 }),
    answer: Type.Optional(Type.Union([Type.Literal("accept"), Type.Literal("reject"), Type.Literal("timeout"), Type.Literal("cancel")])),
    option_id: Type.Optional(Type.String({ minLength: 1 })),
    content: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }, strict),
};

export interface ToolSpec {
  name: BridgeMethod;
  /** Server HTTP method this tool calls; defaults to `name`. `create_template` → `register_template`. */
  method?: BridgeHttpMethod;
  label: string;
  description: string;
  parameters: TSchema;
}

export const OUTPUT_SCHEMA = Type.Record(Type.String(), Type.Unknown());

export const TOOL_SPECS: ToolSpec[] = [
  { name: "ping", label: "ACP Ping", parameters: parameters.ping,
    description: "Check that the harness-acp-bridge server is reachable. Returns protocol version, PID, uptime, live session count, and configuration fingerprint. Starts no harness." },
  { name: "search_template", label: "ACP Search Template", parameters: parameters.search_template,
    description: "Find registered launch templates by exact name, free-text query (case-insensitive substring of name/harness/description), and/or harness. Returns each match in full — including its model/thinking, network_mode, before_start/after_start/special_instructions, and command/args/env/cwd/Docker defaults. The calling LLM follows special_instructions throughout, executes before_start before creating the session and after_start after startup (completing required authentication), subject to user approval and safety rules. Never forward these instruction fields to create_session. Templates are INFORMATION ONLY: acp_create_session never accepts a template name, so read the returned object and expand the allowed fields yourself. Starts no harness; never guess a template's contents." },
  { name: "create_template", method: "register_template", label: "ACP Create Template", parameters: parameters.create_template,
    description: "Durably register a launch template (alias for the server's register_template; starts no session and no harness). Supply {template: {...}} with name and harness plus any of description/model/thinking/before_start/after_start/special_instructions/runtime/target/remote_host/permission_mode/command/args/env/cwd/docker_image/container_policy/login_dirs/mounts/ports/network_mode/proxy_port. model/thinking are optional defaults; the last three instruction fields are natural-language guidance executed by the calling LLM, never server hooks. For Docker, ask for network_mode=none (ordinary bridge, no proxy), host (host network, no proxy or published ports), or proxy (ordinary bridge plus proxy_port, an integer 1-65535). In proxy mode the server generates identical lowercase env.http_proxy and env.https_proxy as http://host.docker.internal:PORT and env.no_proxy for localhost/private ranges; it replaces stale proxy variables while preserving unrelated env. Do not ask for three separate proxy values. Proxy service is generic, not tied to Xray. Old template host_network is rejected. Never guess protocol/host/port or use container loopback for the host. A duplicate name is rejected (template_exists) and never overwrites. Follow the acp-create-template skill: collect values from the user and confirm a summary first." },
  { name: "create_session", label: "ACP Create Session", parameters: parameters.create_session,
    description: "Create a session-owned harness from explicit parameters. cwd and model_id are REQUIRED; there is no template parameter. Launch parameters: harness (codebuddy/codex/agy are built in and need no YAML declaration; omitted uses default_harness, Codex by default); command (absolute executable path or single executable name; empty/omitted uses the harness's built-in command) and args/env; permission_mode/thinking_level; target/remote_host; runtime and the Docker fields (docker_image for a new container, or docker_id to reuse; container_policy, login_dirs, mounts, ports, host_network). login_dirs and mounts are bind mounts used only for runtime=docker; login_dirs persist the harness's own credentials (not bridge credentials). Map a Docker template's network_mode to host_network: host means true, none/proxy mean false; for proxy pass the returned env (generated from proxy_port, with identical http_proxy/https_proxy and common-private-range no_proxy), preserving all three proxy keys and unrelated env. network_mode and proxy_port are template-only, never session fields. Host networking cannot coexist with active proxy values. Verify proxy protocol/host/port reachability from the container; container loopback is not the host. Do not change proxy/firewall settings without approval. This is the harness's proxy, not the bridge client's. To start from a template: acp_search_template (exact name, else query/harness), read the returned object in full, map non-null model to model_id and thinking to thinking_level, apply the user's overrides, and ask only for a missing model_id or cwd. Follow special_instructions throughout, execute before_start before creating the session and after_start after startup (completing required authentication), subject to user approval and safety rules; stop and report failures rather than claiming actions ran. DROP name/description/model/thinking/network_mode/proxy_port/before_start/after_start/special_instructions and any field that does not apply (e.g. all Docker fields for a direct session), then pass only allowed acp_create_session fields — never forward template-only fields. Omit a field the template stores as null when null is not a valid session value (a local template's remote_host: null — pass remote_host only for a remote session; a null cwd — supply the user's cwd). When you override runtime or target, re-check that the remaining fields are still valid (e.g. Docker fields require docker; a remote target needs remote_host). Returns the session snapshot (no template identity). If authentication is required, the structured error carries session_id and a next_action telling you to call acp_authenticate." },
  { name: "close_session", label: "ACP Close Session", parameters: parameters.close_session,
    description: "Stop the harness and close the session. Repeated close is safe." },
  { name: "authenticate", label: "ACP Authenticate", parameters: parameters.authenticate,
    description: "Start or resume the child harness authentication flow for session_id. The client asks every server-provided question, submits each answer without a message_id, and polls until ready/failed/cancelled. Without interactive UI it returns waiting_input and questions for manual acp_answer_question followed by acp_authenticate. Aborting detaches only the local wait." },
  { name: "auth_status", label: "ACP Auth Status", parameters: parameters.auth_status,
    description: "Return the current authentication workflow shape when one exists; otherwise probe harness authentication. Unknown authentication is never guessed as logged out." },
  { name: "set_session_options", label: "ACP Set Session Options", parameters: parameters.set_session_options,
    description: "Change model_id, thinking_level, and/or permission_mode of an idle session. At least one option is required." },
  { name: "send_message", label: "ACP Send Message", parameters: parameters.send_message,
    description: "Submit a prompt to an ACP session and synchronously wait for its final result in the same tool call. Handles reverse permission/information requests with ask_user or native Pi dialogs, then resumes waiting; renders status.progress as UI-only preview. Aborting cancels the remote message. Without interactive UI it returns waiting_input for a manual acp_answer_question followed by acp_wait. Supports idempotency_key." },
  { name: "cancel_message", label: "ACP Cancel Message", parameters: parameters.cancel_message,
    description: "Request cancellation of the active message and wait for the original prompt to settle. An unconfirmed cancellation closes the session." },
  { name: "message_status", label: "ACP Message Status", parameters: parameters.message_status,
    description: "Return a message's state, terminal flag, pending questions, unsupported events, errors, and terminal result. Works after close or server restart." },
  { name: "answer_question", label: "ACP Answer Question", parameters: parameters.answer_question,
    description: "Answer a pending reverse request by session_id/request_id. message_id is required for message questions and omitted for session authentication. answer defaults to accept; permissions require an offered option_id, information/elicitation require an object content." },
];

export const WAIT_SCHEMA = Type.Object({
  session_id: Type.String({ minLength: 1 }),
  message_id: Type.String({ minLength: 1 }),
}, strict);
