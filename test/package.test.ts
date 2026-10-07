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
});
