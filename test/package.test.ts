import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import extension from "../index.ts";
import implementation from "../src/index.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

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
    // The server dependency is the HTTP five-layer server (exports HarnessHttpServer), not the
    // old socket daemon; the bootstrap imports its root export and never a deep CLI path.
    const server = JSON.parse(readFileSync(new URL("../node_modules/@black942026/harness-acp-bridge-server/package.json", import.meta.url), "utf8"));
    expect(server.name).toBe("@black942026/harness-acp-bridge-server");
    expect(server.exports["."]).toBe("./dist/index.js");
  });
});
