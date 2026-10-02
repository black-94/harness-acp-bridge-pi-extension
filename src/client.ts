import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isRecord, type BridgeSettings } from "./config.ts";

const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };

export interface BridgeConnection {
  call(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string, public readonly payload?: unknown) {
    super(message);
    this.name = "BridgeError";
  }
}

/** No daemon, ACP transport, launch logic or scheduling is implemented here. */
export class BridgeClient implements BridgeConnection {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<Tool[]>;
  private tools?: Tool[];
  private closed = false;

  constructor(private readonly settings: BridgeSettings) {}

  connect(): Promise<Tool[]> {
    if (this.closed) return Promise.reject(new Error("Bridge client is closed"));
    if (this.tools) return Promise.resolve(this.tools);
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(): Promise<Tool[]> {
    const client = new Client({ name, version });
    const transport = new StdioClientTransport({
      command: this.settings.command, args: this.settings.args, cwd: this.settings.cwd,
      env: { ...getDefaultEnvironment(), ...this.settings.env },
      stderr: "pipe",
    });
    // Drain stderr without mixing it into the MCP stream or retaining credentials.
    transport.stderr?.on("data", () => {});
    this.client = client;
    this.transport = transport;
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        this.transport = undefined;
        this.tools = undefined;
      }
    };
    try {
      await client.connect(transport, { timeout: this.settings.requestTimeoutMs });
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.settings.requestTimeoutMs });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      if (this.closed) throw new Error("Bridge client closed during initialization");
      this.tools = tools;
      return tools;
    } catch (error) {
      await client.close().catch(() => {});
      if (this.client === client) { this.client = undefined; this.transport = undefined; }
      throw error;
    }
  }

  async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    await this.connect();
    signal?.throwIfAborted();
    // Never automatically retry mutating calls: the server may already have accepted them.
    const result = await this.client!.callTool(
      { name, arguments: args }, undefined,
      { signal, timeout: this.settings.requestTimeoutMs },
    );
    let data: unknown = result.structuredContent;
    if (!isRecord(data)) {
      const text = Array.isArray(result.content)
        ? result.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
      try { data = JSON.parse(text); }
      catch { throw new BridgeError("invalid_result", `Non-JSON response from ${name}`); }
    }
    if (!isRecord(data)) throw new BridgeError("invalid_result", `Expected object from ${name}`);
    if (result.isError) {
      throw new BridgeError(String(data.code ?? "server_error"), String(data.message ?? "Bridge tool failed"), data);
    }
    return data;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.tools = undefined;
    await this.client?.close().catch(() => {});
    await this.transport?.close().catch(() => {});
    await this.connecting?.catch(() => {});
  }
}
