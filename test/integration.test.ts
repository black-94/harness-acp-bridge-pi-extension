/**
 * End-to-end Pi client tests: the extension starts a real harness-acp-bridge server (the in-repo
 * server build) on demand and drives the server's fake ACP harness. Skips when the new-contract
 * server build or the harness fixture is missing. No paid model, Docker, or SSH.
 */
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { context } from "./helpers.ts";
import { fakeHarness, newContractServerEntry, serverSpawningAvailable } from "./server-build.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(r => server.close(() => r()));
  return port;
}

interface Host {
  execute: (name: string, args: unknown, signal?: AbortSignal, onUpdate?: (u: AgentToolResult<Record<string, unknown>>) => void) => Promise<AgentToolResult<Record<string, unknown>>>;
  tools: Map<string, ToolDefinition>;
  ctx: ExtensionToolContext;
  shutdown: () => Promise<void>;
}

describe.runIf(serverSpawningAvailable())("Pi client against a real server it starts on demand", () => {
  let dir: string;
  let clientDir: string;
  let baseUrl: string;
  let host: Host;
  let session: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-acp-e2e-"));
    clientDir = join(dir, "client");
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    writeFileSync(join(dir, "config.yaml"), JSON.stringify({
      schema_version: 2,
      paths: { state_dir: join(dir, "sessions") },
      server: { host: "127.0.0.1", port },
      sessions: { max_concurrency: 4, reap_interval_seconds: 1 },
      timeouts: { startup_timeout_seconds: 5, request_timeout_seconds: 2, turn_timeout_seconds: 8, turn_cancel_timeout_seconds: 0.5, terminate_grace_seconds: 0.1, remote_cleanup_timeout_seconds: 0.1, authentication_timeout_seconds: 1 },
      buffers: { preview_text_bytes: "8B" },
      authentication: { rate_limit: { enabled: false } },
      // This suite's normal fake harness is CodeBuddy; exercise default Codex in server tests.
      default_harness: "codebuddy",
    }));
    // Harness commands come from an explicit command/args/env or the target PATH, never YAML launch settings.
    const bin = join(dir, "bin"); mkdirSync(bin);
    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
    for (const [command, flags] of [["codebuddy", ""], ["codex-acp", "--fake-agent=codex --auth-methods"]]) {
      writeFileSync(join(bin, command), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeHarness)} ${flags} "$@"\n`, { mode: 0o755 });
    }
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("HARNESS_ACP_BRIDGE_CLIENT_DIR", clientDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));

    const tools = new Map<string, ToolDefinition>();
    const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
    const api = {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, callback),
      appendEntry: vi.fn(), getActiveTools: () => [...tools.keys()], getAllTools: () => [...tools.values()],
      sendUserMessage: vi.fn(), sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "harness-acp-bridge.json"), JSON.stringify({
      baseUrl, autoStart: true, serverEntry: newContractServerEntry(), configPath: join(dir, "config.yaml"),
      pollIntervalMs: 20, interactionTimeoutMs: 5000, requestTimeoutMs: 15000, startupTimeoutMs: 20000,
    }));
    const ctx = context({ cwd: dir, hasUI: true });
    Object.assign(ctx, { sessionManager: { getBranch: () => [], getEntries: () => [] } });
    extension(api);
    await events.get("session_start")!({}, ctx);

    host = {
      ctx,
      tools,
      execute: (name, args, signal, onUpdate) => tools.get(name)!.execute("call-1", args, signal, onUpdate as never, ctx) as Promise<AgentToolResult<Record<string, unknown>>>,
      shutdown: async () => { await events.get("session_shutdown")!({}, ctx); },
    };
  }, 40000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    try { const registry = JSON.parse(readFileSync(join(clientDir, "servers.json"), "utf8")) as Record<string, { pid: number | null }>; for (const entry of Object.values(registry)) if (entry.pid) { try { process.kill(entry.pid, "SIGTERM"); } catch { /* gone */ } } } catch { /* none */ }
    // The detached server keeps writing its log briefly after SIGTERM; retry the recursive remove.
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("autostarts the server, then creates a session and synchronously completes a message", async () => {
    // session_start already started the local server on demand.
    expect(existsSync(join(clientDir, "servers.json"))).toBe(true);
    session = (await host.execute("acp_create_session", { cwd: dir, model_id: "fake-model" })).details!.session_id as string;
    const result = await host.execute("acp_send_message", { session_id: session, text: "hello 中文😀" });
    expect(result.details!.terminal).toBe(true);
    expect((result.details!.result as { text: string }).text).toBe("echo:hello 中文😀");
  });

  // Session directories live directly under the configured state_dir.
  const sessionDirs = (): string[] => readdirSync(join(dir, "sessions"), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

  it("registers and searches a template through the alias without starting a harness", async () => {
    const before = sessionDirs();
    const guidance = { model: "fake-model", thinking: "low", before_start: "检查启动依赖。",
      after_start: "检查会话状态。", special_instructions: "遵循用户指示 😀" };
    const created = await host.execute("acp_create_template", { template: { name: "pi-local", harness: "codebuddy", description: "local direct", cwd: dir, ...guidance } });
    // The alias returned the server's stored template with defaults applied, and no session id.
    expect(created.details).toMatchObject({
      template: { name: "pi-local", harness: "codebuddy", runtime: "direct", target: "local", cwd: dir, permission_mode: "auto", args: [], env: {}, ...guidance },
    });
    expect(created.details!.session_id).toBeUndefined();
    // Registering starts no harness: no new session directory appears.
    expect(sessionDirs()).toEqual(before);
    // The tool posts to register_template, never a non-existent create_template endpoint.
    const byName = await host.execute("acp_search_template", { name: "pi-local" });
    expect((byName.details!.templates as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "pi-local", cwd: dir, mounts: [], ports: [], ...guidance });
    const byQuery = await host.execute("acp_search_template", { query: "PI-LOCAL" });
    expect((byQuery.details!.templates as Array<{ name: string }>).map(t => t.name)).toContain("pi-local");
    const byHarness = await host.execute("acp_search_template", { harness: "codebuddy" });
    expect((byHarness.details!.templates as Array<{ name: string }>).map(t => t.name)).toContain("pi-local");
    // Searching also starts nothing.
    expect(sessionDirs()).toEqual(before);
  });

  it("rejects a duplicate template name instead of overwriting it", async () => {
    await expect(host.execute("acp_create_template", { template: { name: "pi-local", harness: "codebuddy", description: "changed" } }))
      .rejects.toMatchObject({ code: "template_exists" });
    const found = await host.execute("acp_search_template", { name: "pi-local" });
    expect((found.details!.templates as Array<{ description: string }>)[0]!.description).toBe("local direct");
  });

  it("expands a searched template into explicit create_session parameters (no template/meta) and honors a cwd override", async () => {
    const overrideDir = join(dir, "override-cwd");
    mkdirSync(overrideDir, { recursive: true });
    // LLM-style expansion: read the template, hand-pick only the fields create_session accepts.
    const t = ((await host.execute("acp_search_template", { name: "pi-local" })).details!.templates as Array<Record<string, unknown>>)[0]!;
    const expand = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      harness: t.harness, runtime: t.runtime, target: t.target, permission_mode: t.permission_mode,
      command: t.command, args: t.args, env: t.env, cwd: t.cwd,
      ...(t.model !== null ? { model_id: t.model } : {}),
      ...(t.thinking !== null ? { thinking_level: t.thinking } : {}), ...overrides,
    });
    for (const forbidden of ["template", "name", "description", "model", "thinking", "before_start", "after_start", "special_instructions"]) expect(expand({})).not.toHaveProperty(forbidden);

    const inherited = await host.execute("acp_create_session", expand({}));
    expect(inherited.details!.options).toMatchObject({ model_id: "fake-model", thinking_level: "low" });
    expect(inherited.details!.cwd).toBe(dir);
    expect(inherited.details!.template).toBeUndefined();
    const result = await host.execute("acp_send_message", { session_id: inherited.details!.session_id as string, text: "via-expansion" });
    expect((result.details!.result as { text: string }).text).toBe("echo:via-expansion");
    await host.execute("acp_close_session", { session_id: inherited.details!.session_id as string });

    const overridden = await host.execute("acp_create_session", expand({ cwd: overrideDir, model_id: "fake-model-2", thinking_level: "high" }));
    expect(overridden.details!.options).toMatchObject({ model_id: "fake-model-2", thinking_level: "high" });
    expect(overridden.details!.cwd).toBe(overrideDir);
    expect(overridden.details!.cwd).not.toBe(dir);
    await host.execute("acp_close_session", { session_id: overridden.details!.session_id as string });
  });

  it("runs a fake harness with the command/args/env expanded from a template", async () => {
    const promptFile = join(dir, "expanded-prompts.txt");
    await host.execute("acp_create_template", { template: { name: "pi-rich", harness: "codebuddy", command: process.execPath, args: [fakeHarness], env: { FAKE_HARNESS_PROMPT_FILE: promptFile }, cwd: dir } });
    const found = ((await host.execute("acp_search_template", { name: "pi-rich" })).details!.templates as Array<Record<string, unknown>>)[0]!;
    expect(found).toMatchObject({ command: process.execPath, args: [fakeHarness], env: { FAKE_HARNESS_PROMPT_FILE: promptFile } });
    const session = (await host.execute("acp_create_session", {
      harness: found.harness, runtime: found.runtime, target: found.target, command: found.command,
      args: found.args, env: found.env, cwd: found.cwd, model_id: "fake-model",
    })).details!.session_id as string;
    const status = await host.execute("acp_send_message", { session_id: session, text: "expanded-env" });
    expect((status.details!.result as { text: string }).text).toBe("echo:expanded-env");
    // The env reached the harness (it recorded the prompt), proving command+args+env were applied.
    expect(readFileSync(promptFile, "utf8")).toContain("expanded-env");
    await host.execute("acp_close_session", { session_id: session });
  });

  it("round-trips a searched Docker template under a new name (null host_ip)", async () => {
    await host.execute("acp_create_template", { template: {
      name: "pi-docker-rt", harness: "codebuddy", runtime: "docker", docker_image: "example:latest", cwd: "/workspace",
      network_mode: "proxy", proxy_port: 12345, env: { KEEP: "keep", HTTPS_PROXY: "stale" },
      ports: [{ host_port: 8080, container_port: 8080, protocol: "tcp", host_ip: null }],
      mounts: [{ source: "/host/repo", target: "/workspace", read_only: false }],
    } });
    const searched = (await host.execute("acp_search_template", { name: "pi-docker-rt" })).details!.templates as Array<Record<string, unknown>>;
    expect((searched[0]!.ports as Array<Record<string, unknown>>)[0]).toMatchObject({ host_port: 8080, protocol: "tcp", host_ip: null });
    expect(searched[0]).not.toHaveProperty("host_network");
    expect(searched[0]).toMatchObject({ network_mode: "proxy", proxy_port: 12345, env: {
      KEEP: "keep", http_proxy: "http://host.docker.internal:12345", https_proxy: "http://host.docker.internal:12345",
      no_proxy: "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local,.internal",
    } });
    expect(searched[0]!.env).not.toHaveProperty("HTTPS_PROXY");
    const renamed = await host.execute("acp_create_template", { template: { ...searched[0], name: "pi-docker-rt-2" } });
    expect(renamed.details!.template).toMatchObject({ name: "pi-docker-rt-2", docker_image: "example:latest", runtime: "docker", env: searched[0]!.env, proxy_port: 12345 });
  });

  it("rejects a template reference, launch internals, and an invalid template", async () => {
    // create_session never references a template: naming one is an unsupported parameter.
    await expect(host.execute("acp_create_session", { template: "pi-local", model_id: "fake-model" }))
      .rejects.toMatchObject({ code: "unknown_param" });
    await expect(host.execute("acp_create_session", { cwd: dir, model_id: "fake-model", session_dir: "/tmp/x" }))
      .rejects.toMatchObject({ code: "launch_internal" });
    await expect(host.execute("acp_create_template", { template: { name: "pi-bad-docker", harness: "codebuddy", docker_image: "img:1" } }))
      .rejects.toMatchObject({ code: "invalid_template" });
  });

  it("rejects a create_session without cwd at the server", async () => {
    await expect(host.execute("acp_create_session", { model_id: "fake-model" })).rejects.toMatchObject({ code: "invalid_param" });
  });

  it("keeps the turn running until a permission popup is answered", async () => {
    vi.mocked(host.ctx.ui.select).mockResolvedValue("1. Allow once [allow_once]");
    const result = await host.execute("acp_send_message", { session_id: session, text: "permission" });
    expect(result.details!.terminal).toBe(true);
    expect((result.details!.result as { text: string }).text).toContain("[allowed:allow_once]");
    expect(host.ctx.ui.select).toHaveBeenCalled();
  });

  it("does not register acp_live_output (progress is UI-only, read from message_status)", async () => {
    expect(existsSync(join(clientDir, "servers.json"))).toBe(true);
    expect(host.tools.has("acp_live_output")).toBe(false);
    // A normal message still completes and returns the terminal result, not a preview.
    const result = await host.execute("acp_send_message", { session_id: session, text: "fragments😀" });
    expect(result.details!.terminal).toBe(true);
    expect((result.details!.result as { text: string }).text).toBe("echo:fragments😀");
  });

  it("returns waiting_input without UI, answers explicitly, then clears the remote message", async () => {
    (host.ctx as { hasUI: boolean }).hasUI = false;
    const pending = await host.execute("acp_send_message", { session_id: session, text: "permission" });
    expect(pending.details!.state).toBe("waiting_input");
    const message = pending.details!.message_id as string;
    const question = (pending.details!.questions as Array<{ request_id: string }>)[0];
    await host.execute("acp_answer_question", { session_id: session, message_id: message, request_id: question.request_id, option_id: "allow_once" });
    const done = await host.execute("acp_wait", { session_id: session, message_id: message });
    expect(done.details!.terminal).toBe(true);

    const second = await host.execute("acp_send_message", { session_id: session, text: "permission" });
    const cancelled = await host.execute("acp_cancel_message", { session_id: session, message_id: second.details!.message_id });
    expect(cancelled.details!.state).toBe("cancelled");
    (host.ctx as { hasUI: boolean }).hasUI = true;
    await host.execute("acp_close_session", { session_id: session });
  });

  it("drives a real unauthenticated session through the auth flow to ready", async () => {
    // A login-gated harness: create_session surfaces the structured authentication_required error.
    const created = await host.execute("acp_create_session", { cwd: dir, model_id: "fake-model", harness: "codex" });
    expect(created.isError).toBe(true);
    const failure = created.structuredContent as { error: { code: string; detail: { session_id: string } } };
    expect(failure.error.code).toBe("authentication_required");
    const sessionId = failure.error.detail.session_id;
    expect(typeof sessionId).toBe("string");

    // Method selection + the device-code URL confirm both go through the native UI. The shared
    // `host.ctx` spy accumulated calls from earlier tests, so clear it before asserting the count.
    // Never hard-code option positions: pick the actual label whose choice is the `device` method,
    // then the actual label whose choice is `true` (the opened confirm).
    vi.mocked(host.ctx.ui.select).mockReset();
    vi.mocked(host.ctx.ui.select).mockImplementation((_title: string, choices?: readonly string[]) => {
      const labels = choices ?? [];
      const device = labels.find(label => label.includes('"device"'));
      if (device !== undefined) return Promise.resolve(device);
      const opened = labels.find(label => /\btrue\b/.test(label));
      return Promise.resolve(opened);
    });
    const ready = await host.execute("acp_authenticate", { session_id: sessionId });
    expect((ready.details as { state: string }).state).toBe("ready");
    expect((ready.details as { terminal: boolean }).terminal).toBe(true);
    // The device-code confirmation is not success by itself; the flow kept polling to ready.
    expect(host.ctx.ui.select).toHaveBeenCalledTimes(2);
    const urlTitle = vi.mocked(host.ctx.ui.select).mock.calls[1]![0];
    // The full verification URL and the device code must both be displayed to the user.
    expect(urlTitle).toContain("https://example.test/device");
    expect(urlTitle).toContain("ABCD-1234");

    const status = await host.execute("acp_auth_status", { session_id: sessionId });
    expect((status.details as { authenticated: boolean }).authenticated).toBe(true);
    await host.execute("acp_close_session", { session_id: sessionId });
  });

  it("does not kill the reused server on shutdown", async () => {
    const registry = JSON.parse(readFileSync(join(clientDir, "servers.json"), "utf8")) as Record<string, { pid: number }>;
    const pid = Object.values(registry)[0]!.pid;
    await host.shutdown();
    const response = await fetch(`${baseUrl}/api/ping`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    expect((await response.json() as { ok: boolean }).ok).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });
});
