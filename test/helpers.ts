import { afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { AskUserToolVerifier, ASK_USER_PACKAGE } from "../src/tool-trust.ts";
import type { Question } from "../src/interactions.ts";

const askPackageRoot = mkdtempSync(join(tmpdir(), "pi-acp-ask-user-"));
writeFileSync(join(askPackageRoot, "package.json"), JSON.stringify({ name: ASK_USER_PACKAGE, version: "0.1.4" }));
writeFileSync(join(askPackageRoot, "index.ts"), "export default () => {};\n");
afterAll(() => rmSync(askPackageRoot, { recursive: true, force: true }));
export const askToolInfo = {
  name: "ask_user", description: "Ask a user", parameters: { type: "object", properties: {} }, exposure: "direct",
  sourceInfo: { path: join(askPackageRoot, "index.ts"), source: `npm:${ASK_USER_PACKAGE}`, scope: "user", origin: "package", baseDir: askPackageRoot },
} as ToolInfo;
export function askVerifier(): AskUserToolVerifier { return new AskUserToolVerifier(() => [askToolInfo]); }

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
