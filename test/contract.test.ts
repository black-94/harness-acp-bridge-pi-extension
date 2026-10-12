/**
 * Static tool/schema contract (Pi client).
 *
 * Guards the deliberate contract changes: `live_output` is gone, `authenticate` no longer accepts a
 * `method_id`, and `create_session` is decoupled from templates (it requires `cwd`/`model_id`, takes
 * the launch executable directly, and has no `template` parameter) while the template tools remain
 * an information store. Also asserts the tool↔HTTP-method routing.
 */
import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import { TOOL_SPECS, WAIT_SCHEMA, type BridgeMethod } from "../src/schemas.ts";

const ajv = new Ajv({ strict: false, allErrors: true });
const spec = (name: BridgeMethod) => TOOL_SPECS.find(tool => tool.name === name)!;
const accepts = (name: BridgeMethod, value: unknown): boolean => ajv.compile(spec(name).parameters as object)(value as never) === true;

describe("Pi tool contract", () => {
  it("exposes the eleven operations plus the two template tools and acp_wait", () => {
    expect(TOOL_SPECS).toHaveLength(13);
    expect(TOOL_SPECS.map(tool => tool.name)).not.toContain("live_output" as never);
    expect(TOOL_SPECS.map(tool => tool.name).sort()).toEqual([
      "answer_question", "auth_status", "authenticate", "cancel_message", "close_session", "create_session",
      "create_template", "message_status", "ping", "search_harness", "search_template",
      "send_message", "set_session_options",
    ]);
    expect(WAIT_SCHEMA).toBeDefined();
  });

  it("maps acp_create_template to register_template and defaults every other tool to its own name", () => {
    expect(spec("create_template").method).toBe("register_template");
    for (const tool of TOOL_SPECS) {
      if (tool.name === "create_template") continue;
      expect(tool.method).toBeUndefined();
    }
  });

  it("authenticate takes only session_id and rejects the old method_id parameter", () => {
    expect(accepts("authenticate", { session_id: "s1" })).toBe(true);
    expect(accepts("authenticate", { session_id: "s1", method_id: "agent" })).toBe(false);
    expect(accepts("authenticate", {})).toBe(false);
  });

  it("create_session no longer accepts an authenticate parameter", () => {
    expect(accepts("create_session", { cwd: "/repo", model_id: "m" })).toBe(true);
    expect(accepts("create_session", { cwd: "/repo", model_id: "m", authenticate: "agent" })).toBe(false);
  });

  it("create_session keeps a JSON-object root requiring cwd and model_id, with no template", () => {
    const root = spec("create_session").parameters as Record<string, unknown>;
    // Some providers reject a root anyOf/union: the root must stay a complete object.
    expect(root.type).toBe("object");
    expect(root.additionalProperties).toBe(false);
    const props = Object.keys(root.properties as Record<string, unknown>);
    expect(props).toEqual(expect.arrayContaining([
      "model_id", "cwd", "harness", "command", "args", "env", "login_dirs",
      "runtime", "docker_image", "mounts", "ports", "host_network",
    ]));
    expect(props).not.toContain("template");
    expect(root.required).toEqual(expect.arrayContaining(["model_id", "cwd"]));
    expect(root.anyOf).toBeUndefined();
    // cwd and model_id are both required; neither can be supplied by a template.
    expect(accepts("create_session", { cwd: "/repo", model_id: "m" })).toBe(true);
    expect(accepts("create_session", { model_id: "m" })).toBe(false);
    expect(accepts("create_session", { cwd: "/repo" })).toBe(false);
  });

  it("create_session accepts the launch executable/argv/env, and rejects template metadata and launch internals", () => {
    expect(accepts("create_session", { cwd: "/repo", model_id: "m", command: process.execPath, args: ["--x"], env: { A: "b" } })).toBe(true);
    // command may be empty/null/omitted (built-in executable), matching the server.
    expect(accepts("create_session", { cwd: "/repo", model_id: "m", command: null })).toBe(true);
    expect(accepts("create_session", { cwd: "/repo", model_id: "m", command: "" })).toBe(true);
    // The launch executable is caller-supplied now; the remaining internals stay server-owned.
    for (const forbidden of ["template", "name", "description"]) {
      expect(accepts("create_session", { cwd: "/repo", model_id: "m", [forbidden]: "x" })).toBe(false);
    }
    for (const internal of ["session_dir", "state_dir", "ssh_command"]) {
      expect(accepts("create_session", { cwd: "/repo", model_id: "m", [internal]: "x" })).toBe(false);
    }
  });

  it("create_session rejects NUL in every launch string (and ajv preserves a __proto__ env key)", () => {
    const base = { cwd: "/w", model_id: "m" };
    expect(accepts("create_session", { ...base, cwd: "/w\0bad" })).toBe(false);
    expect(accepts("create_session", { ...base, model_id: "m\0odel" })).toBe(false);
    expect(accepts("create_session", { ...base, command: "a\0b" })).toBe(false);
    expect(accepts("create_session", { ...base, args: ["a\0b"] })).toBe(false);
    expect(accepts("create_session", { ...base, env: { OK: "a\0b" } })).toBe(false);
    expect(accepts("create_session", { ...base, runtime: "docker", docker_image: "i\0mg" })).toBe(false);
    expect(accepts("create_session", { ...base, runtime: "docker", docker_image: "i", mounts: [{ source: "/a\0b", target: "/b" }] })).toBe(false);
    expect(accepts("create_session", { ...base, runtime: "docker", docker_image: "i", login_dirs: [{ source: "/a", target: "/b\0c" }] })).toBe(false);
    // ajv validates in place and preserves the own key, so Pi forwards it (no silent strip).
    expect(accepts("create_session", { ...base, env: JSON.parse('{"__proto__":"ok","constructor":"c"}') })).toBe(true);
  });

  it("create_session enforces the docker cross-field combinations", () => {
    const id = "a".repeat(64);
    // host_network cannot be combined with published ports.
    expect(accepts("create_session", { cwd: "/w", model_id: "m", runtime: "docker", docker_image: "img", host_network: true, ports: [{ host_port: 1, container_port: 2 }] })).toBe(false);
    // A reused container already fixes its image/mounts/ports/network.
    expect(accepts("create_session", { cwd: "/w", model_id: "m", runtime: "docker", docker_id: id, docker_image: "img" })).toBe(false);
    expect(accepts("create_session", { cwd: "/w", model_id: "m", runtime: "docker", docker_id: id, login_dirs: [{ source: "/a", target: "/b" }] })).toBe(false);
    expect(accepts("create_session", { cwd: "/w", model_id: "m", runtime: "docker", docker_id: id })).toBe(true);
    // Effective Docker options require runtime=docker; neutral defaults are accepted.
    expect(accepts("create_session", { cwd: "/w", model_id: "m", docker_image: "img" })).toBe(false);
    expect(accepts("create_session", { cwd: "/w", model_id: "m", runtime: "direct", docker_image: null, container_policy: null, login_dirs: [], mounts: [], ports: [], host_network: false })).toBe(true);
  });

  it("search_template accepts only name/query/harness", () => {
    expect(accepts("search_template", {})).toBe(true);
    expect(accepts("search_template", { name: "t" })).toBe(true);
    expect(accepts("search_template", { query: "docker" })).toBe(true);
    expect(accepts("search_template", { harness: "codebuddy" })).toBe(true);
    expect(accepts("search_template", { name: "t", query: "x", harness: "codebuddy" })).toBe(true);
    expect(accepts("search_template", { detail: true })).toBe(false);
  });

  it("create_template requires name/harness and accepts exactly the server's registrable fields", () => {
    expect(accepts("create_template", { template: { name: "t", harness: "codebuddy" } })).toBe(true);
    expect(accepts("create_template", { template: { name: "t" } })).toBe(false);
    expect(accepts("create_template", { template: { harness: "codebuddy" } })).toBe(false);
    expect(accepts("create_template", { name: "t", harness: "codebuddy" })).toBe(false); // must be nested
    expect(accepts("create_template", {
      template: {
        name: "codebuddy-docker", description: "docker", harness: "codebuddy", runtime: "docker",
        target: "remote", remote_host: "user@host", permission_mode: "edit",
        command: "codebuddy", args: ["--flag"], env: { HOME: "/home/user" }, cwd: "/workspace",
        docker_image: "img:1", container_policy: "keep",
        login_dirs: [{ source: "/a", target: "/b", read_only: true }],
        mounts: [{ source: "/c", target: "/d" }],
        ports: [{ host_port: 1, container_port: 2, protocol: "udp", host_ip: "127.0.0.1" }],
        host_network: false,
      },
    })).toBe(true);
    // Nullable fields accept null; enums are validated.
    expect(accepts("create_template", { template: { name: "t", harness: "codex", cwd: null, command: null, description: null } })).toBe(true);
    // A template's port host_ip is nullable (the server stores null), so a searched template can be
    // re-registered unchanged; create_session accepts the same nullable shape so a template can be
    // expanded into session parameters without rewriting ports.
    expect(accepts("create_template", { template: { name: "t", harness: "codebuddy", ports: [{ host_port: 1, container_port: 2, host_ip: null }] } })).toBe(true);
    expect(accepts("create_template", { template: { name: "t", harness: "codebuddy", ports: [{ host_port: 1, container_port: 2 }] } })).toBe(true);
    expect(accepts("create_session", { cwd: "/repo", model_id: "m", runtime: "docker", docker_image: "img:1", ports: [{ host_port: 1, container_port: 2, host_ip: null }] })).toBe(true);
    expect(accepts("create_template", { template: { name: "t", harness: "nope" } })).toBe(false);
    expect(accepts("create_template", { template: { name: "t", harness: "codebuddy", runtime: "vm" } })).toBe(false);
    // Unknown template fields are rejected, including launch internals the server owns.
    for (const extra of ["docker_id", "session_dir", "ssh_host", "container_record_id"]) {
      expect(accepts("create_template", { template: { name: "t", harness: "codebuddy", [extra]: "x" } })).toBe(false);
    }
  });

  it("answer_question makes message_id optional (session-scoped auth answers)", () => {
    expect(accepts("answer_question", { session_id: "s1", request_id: "r1" })).toBe(true);
    expect(accepts("answer_question", { session_id: "s1", message_id: "m1", request_id: "r1" })).toBe(true);
    expect(accepts("answer_question", { session_id: "s1", request_id: "r1", content: { method_id: "agent" } })).toBe(true);
  });
});
