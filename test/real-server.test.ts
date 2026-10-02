import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/client.ts";
import { loadSettings } from "../src/config.ts";
import { MessageMonitor } from "../src/monitor.ts";
import { InteractionRouter } from "../src/interactions.ts";
import { context } from "./helpers.ts";

const serverDir = process.env.ACP_BRIDGE_SERVER_DIR;
describe.runIf(Boolean(serverDir))("real bridge daemon + MCP + fake ACP harness", () => {
  let dir: string;
  let daemon: ChildProcess;
  let client: BridgeClient;
  let session_id: string;
  let monitor: MessageMonitor;
  const ctx = context();

  beforeAll(async () => {
    const root = resolve(serverDir!);
    dir = mkdtempSync(join(tmpdir(), "pi-acp-real-"));
    const config = join(dir, "config.yaml");
    const socket = join(dir, "bridge.sock");
    writeFileSync(config, [
      "schema_version: 1", "default_harness: codebuddy", "paths:",
      `  state_dir: ${JSON.stringify(dir)}`, `  session_dir: ${JSON.stringify(join(dir, "sessions"))}`,
      "server:", `  socket_path: ${JSON.stringify(socket)}`, `  lock_path: ${JSON.stringify(join(dir, "bridge.lock"))}`,
      "sessions:", "  idle_timeout_seconds: 0",
      "transport:", "  startup_timeout_seconds: 10", "  turn_timeout_seconds: 15", "  turn_cancel_timeout_seconds: 2",
      "authentication:", `  ledger_path: ${JSON.stringify(join(dir, "auth-rate.json"))}`,
      "harnesses:", "  codebuddy:", `    command: ${JSON.stringify(process.execPath)}`,
      "    args:", `      - ${JSON.stringify(join(root, "test/fixtures/fake-acp-harness.mjs"))}`,
      "    models:", "      - id: fake-model", "        name: Fake Model",
    ].join("\n"));
    daemon = spawn(process.execPath, [join(root, "dist/daemon/main.js"), "--config", config], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    daemon.stderr!.on("data", data => { stderr += String(data); });
    await vi.waitFor(() => {
      if (daemon.exitCode !== null) throw new Error(`Daemon failed: ${stderr}`);
      expect(existsSync(socket)).toBe(true);
    }, { timeout: 10_000, interval: 50 });
    client = new BridgeClient({
      // Exercise the installed dependency's default CLI, with no global bin on PATH.
      ...loadSettings(dir, { PI_CODING_AGENT_DIR: dir, HARNESS_ACP_BRIDGE_CONFIG: config }),
      requestTimeoutMs: 15_000, interactionTimeoutMs: 5000, pollIntervalMs: 20,
    });
    const tools = await client.connect();
    expect(tools.map(tool => tool.name)).toContain("answer_question");
    const created = await client.call("create_session", { cwd: dir, model_id: "fake-model", harness: "codebuddy" });
    session_id = String(created.session_id);
    monitor = new MessageMonitor(client, new InteractionRouter(5000), ctx, 20);
  }, 20_000);

  afterAll(async () => {
    await monitor?.stop();
    if (session_id) await client?.call("close_session", { session_id }).catch(() => {});
    await client?.close();
    if (daemon && daemon.exitCode === null) {
      const exited = once(daemon, "exit");
      daemon.kill("SIGTERM");
      const force = setTimeout(() => daemon.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the turn running until a permission popup is answered", async () => {
    let approve!: (value: string) => void;
    vi.mocked(ctx.ui.select).mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    const submission = await client.call("send_message", { session_id, text: "permission" });
    let finished = false;
    const resultPromise = monitor.wait({ session_id, message_id: String(submission.message_id) }, ctx)
      .then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalled(), { timeout: 5000 });
    expect(finished).toBe(false);
    const pending = await client.call("message_result", { session_id, message_id: submission.message_id });
    expect(pending.state).toBe("waiting_input");
    approve("1. Allow once [allow_once]");
    const result = await resultPromise;
    expect(result.state).toBe("completed");
    expect(result.text).toContain("[allowed:allow_once]");
  }, 10_000);

  it("answers an information reverse request with the original object", async () => {
    vi.mocked(ctx.ui.input).mockResolvedValue('{"value":"Ada"}');
    const submission = await client.call("send_message", { session_id, text: "info" });
    const result = await monitor.wait({ session_id, message_id: String(submission.message_id) }, ctx);
    expect(result.state).toBe("completed");
    expect(result.text).toContain('[info:{"value":"Ada"}]');
  }, 10_000);

  it("answers a form elicitation without introducing a new turn", async () => {
    vi.mocked(ctx.ui.input).mockResolvedValue("blue");
    const submission = await client.call("send_message", { session_id, text: "elicit-form" });
    const result = await monitor.wait({ session_id, message_id: String(submission.message_id) }, ctx);
    expect(result.state).toBe("completed");
    expect(result.text).toContain('[elicited:{"value":"blue"}]');
  }, 10_000);
});
