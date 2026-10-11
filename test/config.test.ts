import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isLoopback, loadSettings, normalizeBaseUrl, serverEntrySpecifier } from "../src/config.ts";

const dirs: string[] = [];
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "pi-acp-config-")); dirs.push(dir); return dir; }
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe("bridge settings", () => {
  it("defaults to loopback and autostart without touching external config", () => {
    const dir = temp();
    expect(loadSettings(dir, { PI_CODING_AGENT_DIR: dir })).toEqual({
      baseUrl: "http://127.0.0.1:8787", requestTimeoutMs: 900_000, interactionTimeoutMs: 60_000,
      pollIntervalMs: 500, autoStart: true, serverEntry: null, configPath: null, startupTimeoutMs: 30_000,
    });
  });

  it("reads baseUrl, timing, and startup fields from an explicit settings file", () => {
    const dir = temp();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      baseUrl: "http://127.0.0.1:9000/", pollIntervalMs: 700, autoStart: false, serverEntry: "pkg", startupTimeoutMs: 5000,
    }));
    expect(loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: "settings.json" })).toMatchObject({
      baseUrl: "http://127.0.0.1:9000", pollIntervalMs: 700, autoStart: false, serverEntry: "pkg", startupTimeoutMs: 5000,
    });
  });

  it("merges global and project config with project overrides", () => {
    const dir = temp();
    const global = join(dir, "agent");
    mkdirSync(global);
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(global, "harness-acp-bridge.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:1111", pollIntervalMs: 700 }));
    writeFileSync(join(dir, ".pi", "harness-acp-bridge.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:2222" }));
    expect(loadSettings(dir, { PI_CODING_AGENT_DIR: global })).toMatchObject({ baseUrl: "http://127.0.0.1:2222", pollIntervalMs: 700 });
  });

  it("honors HARNESS_ACP_BRIDGE_CONFIG for the server config path", () => {
    const dir = temp();
    expect(loadSettings(dir, { PI_CODING_AGENT_DIR: dir, HARNESS_ACP_BRIDGE_CONFIG: "config.yaml" }).configPath).toBe(join(dir, "config.yaml"));
  });

  it("resolves a relative configPath against the supplied cwd, not process.cwd", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ baseUrl: "http://127.0.0.1:1", configPath: "sub/config.yaml" }));
    expect(loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: path }).configPath).toBe(join(dir, "sub/config.yaml"));
    expect(loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: path }).configPath).not.toContain(process.cwd() + "/sub/config.yaml");
  });

  it("normalizes server entries to file URLs without re-wrapping file: URLs", () => {
    expect(serverEntrySpecifier("@scope/pkg", "/base")).toBeNull();
    expect(serverEntrySpecifier("./server.js", "/base")).toBe(pathToFileURL("/base/server.js").href);
    expect(serverEntrySpecifier("/abs/server.js", "/base")).toBe(pathToFileURL("/abs/server.js").href);
    expect(serverEntrySpecifier("file:///abs/server.js", "/base")).toBe("file:///abs/server.js");
  });

  it("rejects launch plumbing and unknown fields", () => {
    const dir = temp();
    for (const data of [{ command: "node" }, { args: [] }, { env: {} }, { cwd: "x" }, { typo: true }]) {
      const path = join(dir, "settings.json");
      writeFileSync(path, JSON.stringify(data));
      expect(() => loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: path })).toThrow();
    }
  });

  it.each(["ftp://host", "http://user:pass@host", "http://host/x?q=1", "not-a-url"])("rejects unsafe base URLs: %s", bad => {
    expect(() => normalizeBaseUrl(bad, "settings")).toThrow();
  });

  it("classifies loopback addresses", () => {
    expect(isLoopback("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopback("http://localhost:8787")).toBe(true);
    expect(isLoopback("http://192.168.1.5:8787")).toBe(false);
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
