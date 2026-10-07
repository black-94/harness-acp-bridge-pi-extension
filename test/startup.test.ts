import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/client.ts";
import type { BridgeSettings } from "../src/config.ts";
import { redactDiagnostic, startupFailure, validateLaunch } from "../src/startup.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "pi-acp-start-"));
  dirs.push(dir);
  return dir;
}
function settings(extra: Partial<BridgeSettings> = {}): BridgeSettings {
  return { command: process.execPath, args: [resolve("test/fixtures/mcp-server.mjs")],
    cwd: process.cwd(), env: {}, pollIntervalMs: 5, requestTimeoutMs: 5000, interactionTimeoutMs: 100, ...extra };
}
function script(dir: string, text: string) {
  const path = join(dir, "server.mjs");
  writeFileSync(path, text);
  return path;
}
async function startupError(config: BridgeSettings) {
  const client = new BridgeClient(config);
  try {
    const error = await client.connect().catch(error => error);
    expect(error).toBeInstanceOf(Error);
    return error;
  } finally { await client.close(); }
}

describe("client launch preflight", () => {
  it("names the missing Node entry before spawning", async () => {
    const missing = join(directory(), "missing-cli.js");
    expect(await startupError(settings({ args: [missing] }))).toMatchObject({
      code: "invalid_launch", message: expect.stringContaining(`Invalid bridge Node entry: ${missing}: ENOENT`),
    });
  });
  it("resolves a relative entry against the configured cwd", async () => {
    const dir = directory();
    expect(await startupError(settings({ cwd: dir, args: ["missing-cli.js"] }))).toMatchObject({
      code: "invalid_launch", message: expect.stringContaining(join(dir, "missing-cli.js")),
    });
  });
  it("identifies a missing cwd", async () => {
    const cwd = join(directory(), "missing-dir");
    expect(await startupError(settings({ cwd }))).toMatchObject({
      code: "invalid_launch", message: expect.stringContaining(`Invalid bridge cwd: ${cwd}: ENOENT`),
    });
  });
  it("identifies a missing executable", async () => {
    const command = join(directory(), "missing-node");
    expect(await startupError(settings({ command }))).toMatchObject({
      code: "invalid_launch", message: expect.stringContaining(`Invalid bridge executable: ${command}: ENOENT`),
    });
  });
  it("checks PATH using the child environment", async () => {
    expect(await startupError(settings({ command: "missing-acp-command", env: { PATH: directory() } }))).toMatchObject({
      code: "invalid_launch", message: expect.stringContaining("not found or not executable on PATH: missing-acp-command"),
    });
  });
  it("checks executable permissions and rejects directories as entries", async () => {
    const dir = directory();
    const file = script(dir, "");
    chmodSync(file, 0o600);
    expect(await startupError(settings({ command: file }))).toMatchObject({
      code: "invalid_launch", message: expect.stringContaining("EACCES"),
    });
    expect(await startupError(settings({ args: [dir] }))).toMatchObject({
      code: "invalid_launch", message: expect.stringContaining("not a regular file"),
    });
  });
  it("does not guess script positions for complex Node options", () => {
    expect(() => validateLaunch(settings({ args: ["--eval", "console.log('hi')"] }), process.env as Record<string, string>)).not.toThrow();
  });
  it("retries successfully after a missing entry is restored", async () => {
    const path = join(directory(), "server.mjs");
    const client = new BridgeClient(settings({ args: [path] }));
    try {
      await expect(client.connect()).rejects.toMatchObject({ code: "invalid_launch" });
      writeFileSync(path, `import ${JSON.stringify(pathToFileURL(resolve("test/fixtures/mcp-server.mjs")).href)};`);
      expect((await client.connect()).length).toBe(12);
      expect(await client.call("ping")).toEqual({ status: "ok" });
    } finally { await client.close(); }
  });
});

describe("client startup stderr", () => {
  it("surfaces startup stderr instead of only Connection closed", async () => {
    const dir = directory();
    const yaml = join(dir, "missing-config.yaml");
    const entry = script(dir, `process.stderr.write(${JSON.stringify(`configured YAML file does not exist: ${yaml}`)}, () => process.exit(1));`);
    expect(await startupError(settings({ args: [entry] }))).toMatchObject({
      code: "startup_failed", message: expect.stringContaining(`configured YAML file does not exist: ${yaml}`),
    });
  });
  it("still diagnoses missing entries after Node options when preflight cannot infer them", async () => {
    const missing = join(directory(), "missing-cli.js");
    const error = await startupError(settings({ args: ["--no-warnings", missing] }));
    expect(error.code).toBe("startup_failed");
    expect(error.message).toContain("Cannot find module");
    expect(error.message).toContain(missing);
  });
  it("bounds stderr and redacts split credentials and known environment secrets", async () => {
    const dir = directory();
    const entry = script(dir, `process.stderr.write('api_'); setTimeout(() => {
      process.stderr.write('key=split-secret-value\\nopaque-env-secret\\n' + 'x'.repeat(20000), () => process.exit(1));
    }, 10);`);
    const error = await startupError(settings({ args: [entry], env: { MY_TOKEN: "opaque-env-secret" } }));
    expect(error.message).toContain("api_key=[redacted]");
    expect(error.message).not.toContain("split-secret-value");
    expect(error.message).not.toContain("opaque-env-secret");
    expect(error.message.length).toBeLessThan(9000);
    expect(error.payload).toBeUndefined();
  });
  it("adds stderr to handshake timeouts and cleans up the failed process", async () => {
    const dir = directory();
    const entry = script(dir, "process.stderr.write('handshake stalled'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));");
    expect(await startupError(settings({ args: [entry], requestTimeoutMs: 500 }))).toMatchObject({
      code: "startup_failed", message: expect.stringContaining("handshake stalled"),
    });
  });
  it("does not echo arbitrary argv, environment or terminal control sequences", () => {
    const message = startupFailure(settings({ args: ["--password", "argv-secret"], env: { PASSWORD: "env-secret" } }), new Error("bad launch"), "\x1b[31mpassword=env-secret\nBearer abcdef123456\n");
    expect(message).not.toContain("argv-secret");
    expect(message).not.toContain("env-secret");
    expect(message).not.toContain("abcdef123456");
    expect(message).not.toContain("\x1b");
    expect(redactDiagnostic('"api_key":"secret-value"', {})).not.toContain("secret-value");
  });
});
