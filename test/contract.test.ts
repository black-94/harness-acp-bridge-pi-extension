/**
 * Static tool/schema contract (Pi client).
 *
 * Guards the two deliberate contract changes: `live_output` is gone, and `authenticate` no longer
 * accepts a `method_id` (the method is chosen through the interaction UI, never by the caller).
 */
import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import { TOOL_SPECS, WAIT_SCHEMA, type BridgeMethod } from "../src/schemas.ts";

const ajv = new Ajv({ strict: false, allErrors: true });
const spec = (name: BridgeMethod) => TOOL_SPECS.find(tool => tool.name === name)!;
const accepts = (name: BridgeMethod, value: unknown): boolean => ajv.compile(spec(name).parameters as object)(value as never) === true;

describe("Pi tool contract", () => {
  it("exposes eleven operations (no live_output) plus acp_wait", () => {
    expect(TOOL_SPECS).toHaveLength(11);
    expect(TOOL_SPECS.map(tool => tool.name)).not.toContain("live_output" as never);
    expect(TOOL_SPECS.map(tool => tool.name).sort()).toEqual([
      "answer_question", "auth_status", "authenticate", "cancel_message", "close_session", "create_session",
      "message_status", "ping", "search_harness", "send_message", "set_session_options",
    ]);
    expect(WAIT_SCHEMA).toBeDefined();
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

  it("answer_question makes message_id optional (session-scoped auth answers)", () => {
    expect(accepts("answer_question", { session_id: "s1", request_id: "r1" })).toBe(true);
    expect(accepts("answer_question", { session_id: "s1", message_id: "m1", request_id: "r1" })).toBe(true);
    expect(accepts("answer_question", { session_id: "s1", request_id: "r1", content: { method_id: "agent" } })).toBe(true);
  });
});
