import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import extension from "../index.ts";
import implementation from "../src/index.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Pi package entry point", () => {
  it("declares and publishes the root index.ts so Pi displays the package name without :src", () => {
    expect(manifest.pi.extensions).toEqual(["./index.ts"]);
    expect(manifest.files).toContain("index.ts");
    expect(manifest.files).toContain("src");
  });

  it("re-exports the existing extension factory", () => {
    expect(extension).toBe(implementation);
    expect(extension).toBeTypeOf("function");
  });

  it("depends on the HTTP server package and carries no MCP dependency", () => {
    expect(manifest.dependencies["@black942026/harness-acp-bridge-server"]).toBeDefined();
    expect(manifest.dependencies["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(manifest.dependencies["@black942026/harness-acp-bridge-mcp"]).toBeUndefined();
    expect(manifest.devDependencies["@black942026/harness-acp-bridge-mcp"]).toBeUndefined();
    // The server dependency is the HTTP five-layer server (exports HarnessHttpServer), not the
    // old socket daemon; the bootstrap imports its root export and never a deep CLI path.
    const server = JSON.parse(readFileSync(new URL("../node_modules/@black942026/harness-acp-bridge-server/package.json", import.meta.url), "utf8"));
    expect(server.name).toBe("@black942026/harness-acp-bridge-server");
    expect(server.exports["."]).toBe("./dist/index.js");
  });

  it("ships the acp-create-template skill and declares it for discovery", () => {
    // Declared for Pi package discovery and included in the published tarball.
    expect(manifest.pi.skills).toEqual(["./skills"]);
    expect(manifest.files).toContain("skills");
    // The portable form is a directory containing SKILL.md (not a standalone Markdown file).
    const skillPath = join(packageRoot, "skills", "acp-create-template", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
    // The declared name matches the parent directory (the portable choice) and is spec-valid.
    expect(name).toBe("acp-create-template");
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(name!.length).toBeLessThanOrEqual(64);
    expect(description).toBeTruthy();
    expect(description!.length).toBeLessThanOrEqual(1024);
    // It covers both the Pi and the bare MCP tool names and the key safety rules.
    expect(skill).toContain("acp_create_template");
    expect(skill).toContain("create_template");
    expect(skill).toContain("register_template");
    expect(skill).toContain("template_exists");
    expect(skill.toLowerCase()).toContain("secret");
  });
});
