/**
 * Pi oversized-result persistence privacy test.
 *
 * Drives the *real* registered tool through `execute` with a stub HTTP bridge that returns a
 * >20 000-char payload carrying a sentinel, nested credential fields, a body credential, and a
 * malicious error credential (plus a known sensitive env literal). It then reads the actual
 * `result.json` the extension wrote under `/tmp/pi-acp-*` and asserts it is sanitized, mode 600,
 * in a mode-700 directory, while the returned business values are unchanged.
 *
 * Fixtures only; no real secret values.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { context } from "./helpers.ts";

const ORDINARY_MARKER = "BENIGN-BUSINESS-MARKER-KEEP-ME";
const CRED_SENTINEL = "CREDSENTINEL0123456789abcdef";
const FAKE_ENV_SECRET = "fakeEnvLiteralValue9876543210";
const FAKE_PROVIDER = `sk-ant-${CRED_SENTINEL}`;

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function oversizedPayload(): Record<string, unknown> {
  return {
    status: "ok",
    protocol_version: 2,
    business_marker: ORDINARY_MARKER,
    padding: `ordinary filler ${"P".repeat(30_000)} ${ORDINARY_MARKER}`,
    nested: {
      api_key: FAKE_PROVIDER,
      password: "hunter2-not-a-real-one",
      note: `Authorization: Bearer ${FAKE_PROVIDER}`,
      echoed: `known env literal ${FAKE_ENV_SECRET} appears in the body`,
    },
    body_credential: `call with api_key=${CRED_SENTINEL} done`,
    error: { code: "boom", message: `upstream failed token=${FAKE_ENV_SECRET} 中文😀` },
  };
}

async function setup() {
  const payload = oversizedPayload();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, data: payload }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), "pi-acp-oversize-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi", "harness-acp-bridge.json"), JSON.stringify({
    baseUrl, autoStart: false, pollIntervalMs: 5, interactionTimeoutMs: 5000, requestTimeoutMs: 5000,
  }));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
  vi.stubEnv("PI_ACP_BRIDGE_SETTINGS", "");
  vi.stubEnv("HARNESS_ACP_BRIDGE_CONFIG", "");
  // Sensitive-named env key carrying a fake literal; collected when the extension initializes.
  vi.stubEnv("FAKE_API_KEY", FAKE_ENV_SECRET);

  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const api = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, callback),
    appendEntry: vi.fn(), getActiveTools: () => [...tools.keys()], getAllTools: () => [...tools.values()],
    sendUserMessage: vi.fn(), sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = context({ cwd: dir, hasUI: false });
  Object.assign(ctx, { sessionManager: { getBranch: () => [], getEntries: () => [] } });
  extension(api);
  await events.get("session_start")!({}, ctx);
  return { tools, ctx, payload, baseUrl };
}

describe("Pi oversized result persistence", () => {
  it("sanitizes the persisted full-result file and preserves business values", async () => {
    const { tools, ctx, payload } = await setup();
    const tool = tools.get("acp_ping")!;
    const result = (await tool.execute("call-1", {}, undefined, undefined as never, ctx as ExtensionToolContext)) as AgentToolResult<Record<string, unknown>>;

    // Business semantics preserved in memory (details + structuredContent are the real data).
    expect(result.details).toEqual(payload);
    expect(result.structuredContent).toEqual(payload);

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const match = /Full result: (.+)\n?$/.exec(text);
    expect(match, "oversized result should have written a full-result file").not.toBeNull();
    const filePath = match![1]!.trim();

    // Directory mode 700, file mode 600.
    const fileMode = statSync(filePath).mode & 0o777;
    const dirMode = statSync(join(filePath, "..")).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);

    const persisted = readFileSync(filePath, "utf8");
    // No credential sentinel survives in the persisted copy.
    expect(persisted).not.toContain(CRED_SENTINEL);
    expect(persisted).not.toContain(FAKE_ENV_SECRET);
    expect(persisted).not.toContain("hunter2-not-a-real-one");
    expect(persisted).not.toContain("Bearer sk-ant-");
    expect(persisted).toContain("[REDACTED]");
    // Ordinary business content is preserved verbatim.
    expect(persisted).toContain(ORDINARY_MARKER);
    expect(persisted).toContain("中文😀");
  });

  it("never puts a UI preview into the oversized result and truncates the model-facing text", async () => {
    const { tools, ctx } = await setup();
    const tool = tools.get("acp_ping")!;
    const result = (await tool.execute("call-1", {}, undefined, undefined as never, ctx as ExtensionToolContext)) as AgentToolResult<Record<string, unknown>>;
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    // The model-facing text is the truncated preview marker; no preview field is ever attached.
    expect((result.details as Record<string, unknown>).preview).toBeUndefined();
    expect(text).toContain("… truncated …");
  });
});
