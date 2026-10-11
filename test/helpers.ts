import { vi } from "vitest";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { Question } from "../src/interactions.ts";

export function context(overrides: Partial<ExtensionToolContext> = {}): ExtensionToolContext {
  return {
    hasUI: true, mode: "tui", cwd: process.cwd(), tools: [],
    ui: { select: vi.fn(), input: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), confirm: vi.fn() },
    executeTool: vi.fn(),
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    ...overrides,
  } as unknown as ExtensionToolContext;
}

export function permission(overrides: Partial<Question> = {}): Question {
  return {
    request_id: "req-1", kind: "permission", title: "Run bash", message: "Allow command?",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Reject", kind: "reject_once" },
    ],
    schema: null,
    raw: { params: { toolCall: { rawInput: { command: "ls" } } } },
    ...overrides,
  };
}

export function information(schema: Record<string, unknown>): Question {
  return permission({ kind: "information", options: [], schema, raw: { params: {} } });
}

export function askContext(data: unknown): ExtensionToolContext {
  const ctx = context();
  Object.assign(ctx, { tools: [{ name: "ask_user" }] });
  vi.mocked(ctx.executeTool).mockResolvedValue({
    result: { content: [], details: data }, isError: false,
    toolCall: { type: "toolCall", id: "nested", name: "ask_user", arguments: {} },
  } as never);
  return ctx;
}
