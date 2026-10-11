/**
 * Authentication-workflow driver tests (Pi client).
 *
 * The driver is the client half of the server-owned flow: it must present every server-provided
 * question through the interaction UI (never choosing a method or a token itself), forward the
 * user's answer as a session-scoped `answer_question` (no `message_id`), and keep polling until the
 * flow is terminal. A user cancel/timeout is a real answer; a local abort only detaches.
 */
import { describe, expect, it, vi } from "vitest";
import { authenticateSession } from "../src/auth.ts";
import type { InteractionRouter, Question } from "../src/interactions.ts";
import type { BridgeConnection } from "../src/client.ts";
import { context } from "./helpers.ts";

const ref = { session_id: "s1" };

const methodQuestion = (): Question => ({
  request_id: "q-method", kind: "information", title: "Choose an authentication method",
  message: "Choose one supported authentication method. Advertised candidates:\n[{\"id\":\"agent\",\"supported\":true},{\"id\":\"legacy\",\"type\":\"browser\",\"supported\":false,\"description\":\"Not supported in harness_acp_bridge\"}]",
  options: [], schema: { type: "object", properties: { method_id: { type: "string", enum: ["agent"] } }, required: ["method_id"], additionalProperties: false },
});

const tokenQuestion = (): Question => ({
  request_id: "q-token", kind: "information", title: "Enter token",
  message: "Paste the harness token to finish authentication.",
  options: [], schema: { type: "object", properties: { token: { type: "string", minLength: 1 } }, required: ["token"], additionalProperties: false },
});

const urlQuestion = (url: string): Question => ({
  request_id: "q-url", kind: "elicitation", title: "Complete authentication",
  message: `Open this URL and complete authentication, then confirm here: ${url}`,
  options: [], schema: { type: "object", properties: { opened: { type: "boolean", enum: [true] } }, required: ["opened"], additionalProperties: false },
});

interface Flow {
  call: BridgeConnection["call"];
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  answered: number;
  state: { terminal: boolean; question: Question | undefined; started: boolean };
}

/** A stateful fake server: each answer advances to the next question and finally to ready. */
function flow(questions: Question[]): Flow {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const state = { terminal: false, question: undefined as Question | undefined, started: false, answered: 0 };
  const current = () => questions[state.answered];
  const snapshot = () => ({
    session_id: "s1", state: state.terminal ? "ready" : "waiting_input", terminal: state.terminal,
    questions: state.terminal || !state.question ? [] : [state.question],
    candidates: [{ id: "agent", name: "Agent", type: "agent", supported: true }, { id: "legacy", name: "Legacy", type: "browser", supported: false, description: "Not supported in harness_acp_bridge" }],
    ...(state.terminal ? { authenticated: true } : {}),
  });
  const call: BridgeConnection["call"] = async (name, args = {}) => {
    calls.push({ name, args });
    if (name === "authenticate") {
      state.started = true;
      state.question = current();
      return snapshot();
    }
    if (name === "auth_status") return snapshot();
    if (name === "answer_question") {
      state.answered += 1;
      state.question = current();
      if (state.question === undefined) state.terminal = true;
      return snapshot();
    }
    return {};
  };
  return { call, calls, state, get answered() { return state.answered; } } as Flow;
}

const answering = (fn: (question: Question) => unknown): InteractionRouter =>
  ({ resolve: vi.fn(async (question: Question) => fn(question)) }) as unknown as InteractionRouter;

const callsNamed = (calls: Flow["calls"], name: string) => calls.filter(call => call.name === name);

describe("authenticateSession", () => {
  it("presents the method-selection question through the UI and never self-selects", async () => {
    const server = flow([methodQuestion(), tokenQuestion()]);
    const router = answering(question => question.schema?.properties && "method_id" in (question.schema.properties as object)
      ? { answer: "accept", content: { method_id: "agent" } }
      : { answer: "accept", content: { token: "t0ken" } });
    const status = await authenticateSession(server, router, ref, context(), context(), new AbortController().signal, 5);
    expect(status).toMatchObject({ state: "ready", terminal: true, authenticated: true });
    // The method was chosen by the UI, never by the driver.
    expect(router.resolve).toHaveBeenCalled();
    const answers = callsNamed(server.calls, "answer_question");
    expect(answers[0]!.args).toMatchObject({ session_id: "s1", request_id: "q-method", answer: "accept", content: { method_id: "agent" } });
    expect(answers[0]!.args.message_id).toBeUndefined(); // session-scoped: no message_id
  });

  it("supports consecutive token/code rounds (multiple required-input questions)", async () => {
    const second: Question = { ...tokenQuestion(), request_id: "q-code", message: "Enter the device code shown in your browser.", schema: { type: "object", properties: { code: { type: "string", minLength: 1 } }, required: ["code"], additionalProperties: false } };
    const server = flow([methodQuestion(), tokenQuestion(), second]);
    const router = answering(question => {
      const properties = (question.schema?.properties ?? {}) as Record<string, unknown>;
      if ("method_id" in properties) return { answer: "accept", content: { method_id: "agent" } };
      if ("token" in properties) return { answer: "accept", content: { token: "tok" } };
      return { answer: "accept", content: { code: "ABCD-1234" } };
    });
    const status = await authenticateSession(server, router, ref, context(), context(), new AbortController().signal, 5);
    expect(status.terminal).toBe(true);
    expect(router.resolve).toHaveBeenCalledTimes(3);
    expect(callsNamed(server.calls, "answer_question")).toHaveLength(3);
  });

  it("shows the complete URL for a confirm question and keeps polling after the confirmation", async () => {
    const url = `https://auth.example.com/login?state=${"a".repeat(600)}&scope=openid`;
    const server = flow([methodQuestion(), urlQuestion(url)]);
    const seen: Question[] = [];
    const router = answering(question => {
      seen.push(question);
      const properties = (question.schema?.properties ?? {}) as Record<string, unknown>;
      if ("method_id" in properties) return { answer: "accept", content: { method_id: "agent" } };
      return { answer: "accept", content: { opened: true } };
    });
    const status = await authenticateSession(server, router, ref, context(), context(), new AbortController().signal, 5);
    // A confirmation is NOT success: the driver kept polling until the flow reported terminal.
    expect(status.terminal).toBe(true);
    const urlSeen = seen.find(question => question.request_id === "q-url");
    expect(urlSeen?.message).toContain(url); // full URL, no truncation
    expect(callsNamed(server.calls, "answer_question")[1]!.args).toMatchObject({ request_id: "q-url", content: { opened: true } });
  });

  it("shows unsupported candidates (with the harness reason) but only offers supported ids", async () => {
    const server = flow([methodQuestion(), tokenQuestion()]);
    let methodSeen: Question | undefined;
    const router = answering(question => {
      if (question.request_id === "q-method") { methodSeen = question; return { answer: "accept", content: { method_id: "agent" } }; }
      return { answer: "accept", content: { token: "t" } };
    });
    await authenticateSession(server, router, ref, context(), context(), new AbortController().signal, 5);
    // The unsupported candidate is displayed with the server's exact reason...
    expect(methodSeen?.message).toContain("Not supported in harness_acp_bridge");
    expect(methodSeen?.message).toContain("legacy");
    // ...but the offered enum contains only the supported ids, so it can never be auto-selected.
    const methodId = (methodSeen?.schema?.properties as { method_id: { enum: string[] } }).method_id;
    expect(methodId.enum).toEqual(["agent"]);
    expect(methodId.enum).not.toContain("legacy");
  });

  it("returns waiting_input with the full question when no UI is available and sends no answer", async () => {
    const server = flow([methodQuestion()]);
    const router = answering(() => undefined);
    const status = await authenticateSession(server, router, ref, context({ hasUI: false }), context({ hasUI: false }), new AbortController().signal, 5);
    expect(status).toMatchObject({ state: "waiting_input", terminal: false });
    expect((status.questions as Question[])[0]!.request_id).toBe("q-method");
    expect(callsNamed(server.calls, "answer_question")).toHaveLength(0);
  });

  it("forwards a user cancel as a real answer", async () => {
    const server = flow([methodQuestion(), tokenQuestion()]);
    const router = answering(question => (question.request_id === "q-method" ? { answer: "cancel" } : { answer: "accept", content: { token: "x" } }));
    await authenticateSession(server, router, ref, context(), context(), new AbortController().signal, 5);
    expect(callsNamed(server.calls, "answer_question")[0]!.args).toMatchObject({ request_id: "q-method", answer: "cancel" });
  });

  it("forwards a user timeout as a real answer", async () => {
    const server = flow([methodQuestion(), tokenQuestion()]);
    const router = answering(question => (question.request_id === "q-method" ? { answer: "timeout" } : { answer: "accept", content: { token: "x" } }));
    await authenticateSession(server, router, ref, context(), context(), new AbortController().signal, 5);
    expect(callsNamed(server.calls, "answer_question")[0]!.args).toMatchObject({ request_id: "q-method", answer: "timeout" });
  });

  it("aborts the dialog and does not answer when the flow becomes terminal", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let terminal = false;
    const captured: { signal?: AbortSignal } = {};
    const server: BridgeConnection = {
      async call(name, args = {}) {
        calls.push({ name, args });
        if (name === "authenticate") return { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        if (name === "auth_status") return terminal
          ? { session_id: "s1", state: "ready", terminal: true, authenticated: true, questions: [] }
          : { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        return {};
      },
    };
    const router = { resolve: vi.fn((_q: Question, _ctx: unknown, signal: AbortSignal) => { captured.signal = signal; return new Promise(() => { /* never resolves */ }); }) } as unknown as InteractionRouter;
    const promise = authenticateSession(server, router, ref, context(), context(), new AbortController().signal, 5);
    await vi.waitFor(() => expect(captured.signal).toBeDefined());
    terminal = true;
    const status = await promise;
    expect(status.terminal).toBe(true);
    expect(captured.signal?.aborted).toBe(true); // stale dialog was cancelled
    expect(callsNamed(calls, "answer_question")).toHaveLength(0);
  });

  it("detaches locally on abort without answering or cancelling", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const server: BridgeConnection = {
      async call(name, args = {}) {
        calls.push({ name, args });
        if (name === "authenticate") return { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        if (name === "auth_status") return { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        return {};
      },
    };
    const router = { resolve: vi.fn(() => new Promise(() => { /* hangs until aborted */ })) } as unknown as InteractionRouter;
    const controller = new AbortController();
    const promise = authenticateSession(server, router, ref, context(), context(), controller.signal, 5);
    await vi.waitFor(() => expect(router.resolve).toHaveBeenCalled());
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(calls.some(call => call.name === "answer_question" || call.name === "cancel_message")).toBe(false);
  });

  it("forwards a standard permission question's UI-selected option_id", async () => {
    const permission: Question = { request_id: "q-perm", kind: "permission", title: "Allow?", message: "Allow the action?", options: [{ optionId: "allow", name: "Allow" }, { optionId: "deny", name: "Deny" }], schema: null };
    const server = flow([methodQuestion(), permission]);
    const router = answering(question => question.request_id === "q-method"
      ? { answer: "accept", content: { method_id: "agent" } }
      : { answer: "accept", option_id: "allow" });
    const status = await authenticateSession(server, router, ref, context(), context(), new AbortController().signal, 5);
    expect(status.terminal).toBe(true);
    expect(callsNamed(server.calls, "answer_question")[1]!.args).toMatchObject({ request_id: "q-perm", answer: "accept", option_id: "allow" });
    expect(callsNamed(server.calls, "answer_question")[1]!.args.message_id).toBeUndefined();
  });

  it("revalidates before answering: a concurrent driver never submits a stale decision", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let statusCalls = 0;
    const server: BridgeConnection = {
      async call(name, args = {}) {
        calls.push({ name, args });
        if (name === "authenticate") return { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        if (name === "auth_status") {
          statusCalls += 1;
          // Another driver advanced the flow to ready while our dialog was open.
          return statusCalls >= 2
            ? { session_id: "s1", state: "ready", terminal: true, questions: [], authenticated: true }
            : { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        }
        return {};
      },
    };
    const router = { resolve: vi.fn((_q: Question, _ctx: unknown, _signal: AbortSignal) => new Promise(resolve => { setTimeout(() => resolve({ answer: "accept", content: { method_id: "agent" } }), 12); })) } as unknown as InteractionRouter;
    const status = await authenticateSession(server, router, ref, context(), context(), new AbortController().signal, 5);
    expect(status.terminal).toBe(true);
    // Revalidation saw the question already gone, so the stale decision was NOT submitted.
    expect(calls.some(call => call.name === "answer_question")).toBe(false);
  });

  it("returns immediately when the session is already authenticated", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const server: BridgeConnection = { async call(name, args = {}) { calls.push({ name, args }); return { session_id: "s1", state: "ready", terminal: true, questions: [], authenticated: true }; } };
    const router = answering(() => { throw new Error("must not ask"); });
    const status = await authenticateSession(server, router, ref, context(), context(), new AbortController().signal, 5);
    expect(status).toMatchObject({ state: "ready", terminal: true, authenticated: true });
    expect(router.resolve).not.toHaveBeenCalled();
  });
});
