import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { BridgeClient } from "../src/client.ts";
import type { BridgeSettings } from "../src/config.ts";

const settings: BridgeSettings = {
  command: process.execPath, args: [resolve("test/fixtures/mcp-server.mjs")], env: {}, cwd: process.cwd(),
  pollIntervalMs: 5, requestTimeoutMs: 5000, interactionTimeoutMs: 100,
};
describe("MCP client", () => {
  it("shares concurrent initialization and discovers server schemas", async () => {
    const client = new BridgeClient(settings);
    try {
      const [first, second] = await Promise.all([client.connect(), client.connect()]);
      expect(first).toBe(second);
      expect(first.find(tool => tool.name === "send_message")!.inputSchema.required).toEqual(["session_id", "text"]);
      expect(await client.call("ping")).toEqual({ status: "ok" });
    } finally { await client.close(); }
  });
  it("keeps server errors typed and never retries submissions", async () => {
    const client = new BridgeClient(settings);
    try {
      const created = await client.call("create_session", { cwd: process.cwd(), model_id: "fake-model" });
      const args = { session_id: created.session_id, text: "hello" };
      expect(await client.call("send_message", args)).toEqual({ message_id: "msg-1" });
      await expect(client.call("send_message", args)).rejects.toMatchObject({ code: "busy" });
    } finally { await client.close(); }
  });
  it("rejects pre-aborted calls and closes idempotently", async () => {
    const client = new BridgeClient(settings);
    const controller = new AbortController();
    controller.abort();
    await expect(client.call("ping", {}, controller.signal)).rejects.toThrow();
    await client.close();
    await client.close();
    await expect(client.connect()).rejects.toThrow("closed");
  });
});
