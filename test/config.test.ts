import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SERVER_MODULE, findExecutable, isLoopback, loadSettings, normalizeBaseUrl, resolveServerLaunch, serverEntrySpecifier } from "../src/config.ts";

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

describe("shared environment overrides (aligned with the MCP proxy)", () => {
  it("lets shared env vars override defaults", () => {
    const dir = temp();
    expect(loadSettings(dir, {
      PI_CODING_AGENT_DIR: dir,
      HARNESS_ACP_BRIDGE_URL: "http://127.0.0.1:9100/",
      HARNESS_ACP_BRIDGE_AUTOSTART: "false",
      HARNESS_ACP_BRIDGE_SERVER_ENTRY: "./srv.js",
      HARNESS_ACP_BRIDGE_TIMEOUT_MS: "12345",
      HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS: "6789",
      HARNESS_ACP_BRIDGE_CONFIG: "cfg.yaml",
    })).toMatchObject({
      baseUrl: "http://127.0.0.1:9100", autoStart: false, serverEntry: "./srv.js",
      requestTimeoutMs: 12345, startupTimeoutMs: 6789, configPath: join(dir, "cfg.yaml"),
    });
  });

  it("lets shared env vars win over a JSON file, including configPath", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({
      baseUrl: "http://127.0.0.1:1111", autoStart: true, serverEntry: "filepkg",
      configPath: "file.yaml", requestTimeoutMs: 111, startupTimeoutMs: 222,
    }));
    expect(loadSettings(dir, {
      PI_ACP_BRIDGE_SETTINGS: path,
      HARNESS_ACP_BRIDGE_URL: "http://127.0.0.1:2222",
      HARNESS_ACP_BRIDGE_AUTOSTART: "0",
      HARNESS_ACP_BRIDGE_SERVER_ENTRY: "envpkg",
      HARNESS_ACP_BRIDGE_TIMEOUT_MS: "333",
      HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS: "444",
      HARNESS_ACP_BRIDGE_CONFIG: "env.yaml",
    })).toMatchObject({
      baseUrl: "http://127.0.0.1:2222", autoStart: false, serverEntry: "envpkg",
      requestTimeoutMs: 333, startupTimeoutMs: 444, configPath: join(dir, "env.yaml"),
    });
  });

  it("keeps Pi-only JSON keys (interaction/poll) with no shared env var", () => {
    const dir = temp();
    expect(loadSettings(dir, { PI_CODING_AGENT_DIR: dir, HARNESS_ACP_BRIDGE_TIMEOUT_MS: "500" })).toMatchObject({
      requestTimeoutMs: 500, interactionTimeoutMs: 60_000, pollIntervalMs: 500,
    });
  });

  it("rejects invalid shared env values instead of ignoring them", () => {
    const dir = temp();
    expect(() => loadSettings(dir, { PI_CODING_AGENT_DIR: dir, HARNESS_ACP_BRIDGE_URL: "ftp://x" })).toThrow();
    expect(() => loadSettings(dir, { PI_CODING_AGENT_DIR: dir, HARNESS_ACP_BRIDGE_URL: "   " })).toThrow();
    expect(() => loadSettings(dir, { PI_CODING_AGENT_DIR: dir, HARNESS_ACP_BRIDGE_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadSettings(dir, { PI_CODING_AGENT_DIR: dir, HARNESS_ACP_BRIDGE_AUTOSTART: "maybe" })).toThrow();
  });

  it("does not validate a JSON value that a valid environment value shadows", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ baseUrl: "ftp://bad", requestTimeoutMs: "nope", autoStart: "maybe", serverEntry: 5, configPath: 7 }));
    expect(loadSettings(dir, {
      PI_ACP_BRIDGE_SETTINGS: path,
      HARNESS_ACP_BRIDGE_URL: "http://127.0.0.1:9000",
      HARNESS_ACP_BRIDGE_TIMEOUT_MS: "500",
      HARNESS_ACP_BRIDGE_AUTOSTART: "0",
      HARNESS_ACP_BRIDGE_SERVER_ENTRY: "pkg",
      HARNESS_ACP_BRIDGE_CONFIG: "c.yaml",
    })).toMatchObject({
      baseUrl: "http://127.0.0.1:9000", requestTimeoutMs: 500, autoStart: false,
      serverEntry: "pkg", configPath: join(dir, "c.yaml"),
    });
  });

  it("normalizes an empty environment value to null (clearing the JSON entry/path)", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ serverEntry: "pkg", configPath: "file.yaml" }));
    expect(loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: path, HARNESS_ACP_BRIDGE_SERVER_ENTRY: "", HARNESS_ACP_BRIDGE_CONFIG: "" }))
      .toMatchObject({ serverEntry: null, configPath: null });
  });

  it("rejects JSON null numeric fields (shared and Pi-only) but defaults/clears null optional fields", () => {
    const dir = temp();
    for (const bad of [{ requestTimeoutMs: null }, { startupTimeoutMs: null }, { interactionTimeoutMs: null }, { pollIntervalMs: null }]) {
      const path = join(dir, "n.json");
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: path })).toThrow();
    }
    const ok = join(dir, "ok.json");
    writeFileSync(ok, JSON.stringify({ autoStart: null, baseUrl: null, serverEntry: null, configPath: null }));
    expect(loadSettings(dir, { PI_ACP_BRIDGE_SETTINGS: ok })).toMatchObject({
      autoStart: true, baseUrl: "http://127.0.0.1:8787", serverEntry: null, configPath: null,
    });
  });

  it("accepts a valid environment value that shadows a JSON null timeout", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ requestTimeoutMs: null, startupTimeoutMs: null }));
    expect(loadSettings(dir, {
      PI_ACP_BRIDGE_SETTINGS: path, HARNESS_ACP_BRIDGE_TIMEOUT_MS: "1234", HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS: "4321",
    })).toMatchObject({ requestTimeoutMs: 1234, startupTimeoutMs: 4321 });
  });
});

describe("PATH command discovery and entry selection", () => {
  it("finds an executable regular file, following symlinks, normalizing relative/empty PATH entries", () => {
    const dir = temp();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const target = join(dir, "hacpd-real.js");
    writeFileSync(target, "#!/usr/bin/env node\n");
    chmodSync(target, 0o755);
    symlinkSync(target, join(bin, "hacpd"));
    expect(findExecutable("hacpd", { PATH: "bin" }, dir)).toBe(realpathSync(target));

    const inCwd = temp();
    writeFileSync(join(inCwd, "hacpd"), "#!/usr/bin/env node\n", { mode: 0o755 });
    expect(findExecutable("hacpd", { PATH: `:/does-not-exist` }, inCwd)).toBe(realpathSync(join(inCwd, "hacpd")));
  });

  it("skips directories, non-executable files, missing entries, and absent names", () => {
    const dir = temp();
    mkdirSync(join(dir, "asdir", "hacpd"), { recursive: true });
    expect(findExecutable("hacpd", { PATH: join(dir, "asdir") }, dir)).toBeNull();
    mkdirSync(join(dir, "plain"));
    writeFileSync(join(dir, "plain", "hacpd"), "no\n", { mode: 0o644 });
    expect(findExecutable("hacpd", { PATH: join(dir, "plain") }, dir)).toBeNull();
    expect(findExecutable("hacpd", { PATH: join(dir, "missing") }, dir)).toBeNull();
    expect(findExecutable("definitely-absent-xyz", { PATH: dir }, dir)).toBeNull();
  });

  it("selects explicit serverEntry > PATH hacpd > installed module", () => {
    const dir = temp();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const target = join(dir, "cli.js");
    writeFileSync(target, "#!/usr/bin/env node\n");
    chmodSync(target, 0o755);
    symlinkSync(target, join(bin, "hacpd"));
    expect(resolveServerLaunch({ serverEntry: "pkg" }, { PATH: bin }, dir)).toEqual({ kind: "module", specifier: "pkg" });
    expect(resolveServerLaunch({ serverEntry: null }, { PATH: bin }, dir)).toEqual({ kind: "command", command: realpathSync(target) });
    expect(resolveServerLaunch({ serverEntry: null }, { PATH: join(dir, "nope") }, dir)).toEqual({ kind: "module", specifier: DEFAULT_SERVER_MODULE });
  });

  it("treats a missing PATH as no probe, but an explicit empty PATH as the cwd", () => {
    const dir = temp();
    writeFileSync(join(dir, "hacpd"), "#!/usr/bin/env node\n", { mode: 0o755 });
    expect(findExecutable("hacpd", {}, dir)).toBeNull();
    expect(resolveServerLaunch({ serverEntry: null }, {}, dir)).toEqual({ kind: "module", specifier: DEFAULT_SERVER_MODULE });
    expect(findExecutable("hacpd", { PATH: "" }, dir)).toBe(realpathSync(join(dir, "hacpd")));
  });
});
