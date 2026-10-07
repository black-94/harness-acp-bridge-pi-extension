import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.ts";

const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "pi-acp-config-")); dirs.push(dir); return dir; }
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
describe("bridge settings", () => {
  it("uses defaults without touching external config", () => {
    const dir = temp();
    expect(loadSettings(dir, { PI_CODING_AGENT_DIR: dir })).toMatchObject({
      command: process.execPath,
      args: [createRequire(import.meta.url).resolve("@black942026/harness-acp-bridge-server/dist/cli.js")],
      pollIntervalMs: 500,
    });
  });
  it("appends configured args to the dependency CLI when command is omitted", () => {
    const dir = temp();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ args: ["--config", "/config.yaml"] }));
    expect(loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: "settings.json" })).toMatchObject({
      command: process.execPath,
      args: [createRequire(import.meta.url).resolve("@black942026/harness-acp-bridge-server/dist/cli.js"), "--config", "/config.yaml"],
    });
  });
  it("preserves explicit commands without inserting the dependency CLI", () => {
    const dir = temp();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ command: "custom-server", args: ["--config", "/config.yaml"] }));
    expect(loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: "settings.json" })).toMatchObject({
      command: "custom-server", args: ["--config", "/config.yaml"],
    });
  });
  it("merges global and project config with project overrides", () => {
    const dir = temp();
    const global = join(dir, "agent");
    mkdirSync(global);
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(global, "harness-acp-bridge.json"), JSON.stringify({ command: "node", args: ["server"], env: { A: "a" }, pollIntervalMs: 700 }));
    writeFileSync(join(dir, ".pi", "harness-acp-bridge.json"), JSON.stringify({ args: ["project-server"], env: { B: "b" }, cwd: "work" }));
    expect(loadSettings(dir, { PI_CODING_AGENT_DIR: global })).toMatchObject({
      command: "node", args: ["project-server"], env: { A: "a", B: "b" }, pollIntervalMs: 700, cwd: join(dir, "work"),
    });
  });
  it("honors explicit settings and server/config environment overrides", () => {
    const dir = temp();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ command: "custom", args: ["custom"] }));
    expect(loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: "settings.json", HARNESS_ACP_BRIDGE_SERVER: "cli.js", HARNESS_ACP_BRIDGE_CONFIG: "config.yaml" }))
      .toMatchObject({ command: process.execPath, args: [join(dir, "cli.js")], env: { HARNESS_ACP_BRIDGE_CONFIG: join(dir, "config.yaml") } });
  });
  it("inherits standard runtime/connectivity paths but not arbitrary tokens", () => {
    const dir = temp();
    const settings = loadSettings(dir, { PI_CODING_AGENT_DIR: dir, SSH_AUTH_SOCK: "/socket", XDG_RUNTIME_DIR: "/run/test", MY_SECRET: "secret" });
    expect(settings.env).toEqual({ SSH_AUTH_SOCK: "/socket", XDG_RUNTIME_DIR: "/run/test" });
  });
  it.each([
    { pollIntervalMs: 0 }, { interactionTimeoutMs: "100" }, { args: [3] },
    { env: { SECRET: 123 } }, { command: "" }, { typo: true },
  ])("rejects invalid settings %j", data => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify(data));
    expect(() => loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: path })).toThrow();
  });
  it("names malformed settings without exposing the invalid JSON's credentials", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, '{"TOKEN":"do-not-show-this"');
    let error: unknown;
    try { loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: path }); } catch (cause) { error = cause; }
    expect(String(error)).toContain(`${path}: invalid JSON`);
    expect(String(error)).not.toContain("do-not-show-this");
  });
  it("reports a missing explicit config rather than silently falling back", () => {
    const dir = temp();
    expect(() => loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: "missing.json" })).toThrow();
  });
});
