import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ASK_USER_PACKAGE, AskUserToolVerifier, checkAskUserTool, defaultAskUserPolicy, parseAskUserPolicy } from "../src/tool-trust.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "ask-trust-")); dirs.push(dir); return dir; }
function fixture(version = "0.1.4", name = ASK_USER_PACKAGE) {
  const root = temp(); const entry = join(root, "index.ts");
  writeFileSync(entry, "export default () => {};\n");
  const manifest = (value: unknown) => writeFileSync(join(root, "package.json"), JSON.stringify(value));
  manifest({ name, version });
  const tool = { name: "ask_user", description: "Ask", parameters: { type: "object", properties: {} }, exposure: "direct",
    sourceInfo: { path: entry, source: `npm:${ASK_USER_PACKAGE}`, scope: "user", origin: "package", baseDir: root } } as ToolInfo;
  const check = () => checkAskUserTool(tool, defaultAskUserPolicy());
  return { root, entry, tool, manifest, check };
}

describe("interaction tool name, source and installed version", () => {
  it.each(["0.1.4", "0.1.5", "0.1.10", "0.2.0", "1.0.0", "1.0.0+build.1"])("accepts %s at or above the minimum", version => {
    expect(fixture(version).check()).toMatchObject({ trusted: true, toolName: "ask_user", version });
  });
  it.each(["0.1.3", "0.0.99", "0.1.4-rc.1", "0.2.0-beta.1", "garbage", "v0.1.4", "0.1", "01.1.4"])("refuses old/prerelease/invalid version %s", version => {
    expect(fixture(version).check().trusted).toBe(false);
  });
  it("checks exact tool and installed package names", () => {
    const f = fixture(); f.tool.name = "other_ask_user";
    expect(f.check().trusted).toBe(false);
    expect(fixture("0.1.4", `${ASK_USER_PACKAGE}-other`).check().trusted).toBe(false);
    expect(fixture("0.1.4", "@other/pi-ask-user").check().trusted).toBe(false);
  });
  it.each([`${ASK_USER_PACKAGE}`, `npm:${ASK_USER_PACKAGE}-evil`, `npm:${ASK_USER_PACKAGE}.evil`,
    `npm:@other/pi-ask-user`, `npm:${ASK_USER_PACKAGE}@npm:other`,
    "git:github.com/black-94/pi-ask-user", "auto", "inline", "/local/package"])("rejects non-allowlisted source %s", source => {
    const f = fixture(); f.tool.sourceInfo.source = source; expect(f.check().trusted).toBe(false);
  });
  it.each([`npm:${ASK_USER_PACKAGE}@0.1.4`, `npm:${ASK_USER_PACKAGE}@^0.1.4`, `npm:${ASK_USER_PACKAGE}@latest`])("accepts an exact npm package selector %s", source => {
    const f = fixture(); f.tool.sourceInfo.source = source; expect(f.check().trusted).toBe(true);
  });
  it("reads the actual version, not the version claimed in the npm source", () => {
    const f = fixture("0.1.3"); f.tool.sourceInfo.source = `npm:${ASK_USER_PACKAGE}@9.0.0`;
    expect(f.check().trusted).toBe(false);
    f.manifest({ name: ASK_USER_PACKAGE, version: "0.1.4" });
    expect(f.check()).toMatchObject({ trusted: false, reason: "installed version does not match the recorded npm selector" });
  });
  it("supports explicitly allowlisted Git and exact real entry paths", () => {
    const f = fixture(); f.tool.sourceInfo.source = "git:github.com/black-94/pi-ask-user@v0.1.4";
    expect(checkAskUserTool(f.tool, { ...defaultAskUserPolicy(), sources: [f.tool.sourceInfo.source] }).trusted).toBe(true);
    expect(checkAskUserTool(f.tool, { ...defaultAskUserPolicy(), sources: [`path:${f.entry}`] }).trusted).toBe(true);
    expect(checkAskUserTool(f.tool, { ...defaultAskUserPolicy(), sources: [`path:${f.entry}-other`] }).trusted).toBe(false);
  });
  it("supports strict greater-than when configured", () => {
    const f = fixture(); const policy = { ...defaultAskUserPolicy(), minVersionExclusive: true };
    expect(checkAskUserTool(f.tool, policy).trusted).toBe(false);
    f.manifest({ name: ASK_USER_PACKAGE, version: "0.1.5" });
    expect(checkAskUserTool(f.tool, policy).trusted).toBe(true);
  });
  it("rejects absent/incomplete source metadata and synthetic/nonabsolute paths", () => {
    for (const sourceInfo of [undefined, {}, { ...fixture().tool.sourceInfo, path: "relative/index.ts" },
      { ...fixture().tool.sourceInfo, path: "<inline:ask_user>" },
      { ...fixture().tool.sourceInfo, baseDir: undefined }, { ...fixture().tool.sourceInfo, origin: "unknown" }]) {
      const f = fixture(); Object.assign(f.tool, { sourceInfo }); expect(f.check().trusted).toBe(false);
    }
  });
  it("rejects missing, corrupt and versionless manifests", () => {
    const f = fixture(); unlinkSync(join(f.root, "package.json")); expect(f.check().trusted).toBe(false);
    writeFileSync(join(f.root, "package.json"), "not-json"); expect(f.check().trusted).toBe(false);
    f.manifest({ name: ASK_USER_PACKAGE }); expect(f.check().trusted).toBe(false);
  });
  it("does not follow entry or manifest symlinks outside the source directory", () => {
    const f = fixture(); const other = fixture(); unlinkSync(f.entry); symlinkSync(other.entry, f.entry);
    expect(f.check().trusted).toBe(false);
    unlinkSync(f.entry); writeFileSync(f.entry, ""); unlinkSync(join(f.root, "package.json"));
    symlinkSync(join(other.root, "package.json"), join(f.root, "package.json")); expect(f.check().trusted).toBe(false);
  });
  it("accepts a package-root symlink and stays at the nearest package boundary", () => {
    const f = fixture(); const link = join(temp(), "package"); symlinkSync(f.root, link);
    f.tool.sourceInfo.path = join(link, "index.ts"); f.tool.sourceInfo.baseDir = link;
    expect(f.check().trusted).toBe(true);
    const child = join(f.root, "nested"); mkdirSync(child); writeFileSync(join(child, "index.ts"), "");
    writeFileSync(join(child, "package.json"), JSON.stringify({ name: "other", version: "99.0.0" }));
    f.tool.sourceInfo.path = join(child, "index.ts"); expect(f.check().trusted).toBe(false);
  });
  it("rechecks every invocation, including registration replacement or package changes", () => {
    const f = fixture(); let tools = [f.tool]; const verifier = new AskUserToolVerifier(() => tools);
    expect(verifier.verify().trusted).toBe(true);
    f.manifest({ name: ASK_USER_PACKAGE, version: "0.1.3" }); expect(verifier.verify().trusted).toBe(false);
    tools = []; expect(verifier.verify().trusted).toBe(false);
    tools = [f.tool, f.tool]; expect(verifier.verify()).toMatchObject({ trusted: false, reason: "ambiguous tool registration" });
    expect(new AskUserToolVerifier(() => { throw new Error("not initialized"); }).verify().trusted).toBe(false);
  });
});

describe("askUser settings validation", () => {
  it("defaults to the official package, ask_user, and >=0.1.4", () => {
    expect(parseAskUserPolicy(undefined)).toEqual(defaultAskUserPolicy());
    const empty = parseAskUserPolicy({}); empty.sources.push("changed");
    expect(defaultAskUserPolicy().sources).toEqual([`npm:${ASK_USER_PACKAGE}`]);
    expect(parseAskUserPolicy({ sources: [] }).sources).toEqual([]);
  });
  it.each([null, [], { extra: true }, { toolName: " " }, { toolName: null }, { sources: null },
    { sources: "source" }, { sources: [" "] }, { sources: ["path:relative"] }, { minVersion: "^0.1.4" },
    { minVersion: null }, { minVersion: "0.1" }, { minVersionExclusive: "false" }, { minVersionExclusive: null }])("rejects malformed policy %#", policy => {
    expect(() => parseAskUserPolicy(policy)).toThrow();
  });
});
