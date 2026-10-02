import { vi } from "vitest";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { Interaction } from "../src/interactions.ts";

export function context(overrides: Partial<ExtensionToolContext> = {}): ExtensionToolContext {
  return {
    hasUI: true, mode: "tui", cwd: process.cwd(), tools: [],
    ui: { select: vi.fn(), input: vi.fn(), notify: vi.fn(), setStatus: vi.fn() },
    executeTool: vi.fn(),
    ...overrides,
  } as unknown as ExtensionToolContext;
}
export function permission(overrides: Partial<Interaction> = {}): Interaction {
  return {
    request_id: "req-1", permission: true, title: "Run bash", message: "Allow command?",
    raw_input: { command: "ls" }, schema: null, defaults: null,
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Reject", kind: "reject_once" },
    ], ...overrides,
  };
}
export function information(schema: Record<string, unknown>): Interaction {
  return permission({ permission: false, options: [], schema });
}
export function askContext(data: unknown) {
  const ctx = context();
  Object.assign(ctx, { tools: [{ name: "ask_user" }] });
  vi.mocked(ctx.executeTool).mockResolvedValue({
    result: { content: [], details: data }, isError: false,
    toolCall: { type: "toolCall", id: "nested", name: "ask_user", arguments: {} },
  });
  return ctx;
}
