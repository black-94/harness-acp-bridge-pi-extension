import { defaultExclude, defineConfig } from "vitest/config";

// Explicit, opt-in cross-check against the real sibling `../pi-ask-user` normalizer.
// Run with `npm run test:protocol`; never part of the default `npm test`.
export default defineConfig({
  test: { include: ["test/protocol/**/*.test.ts"], exclude: defaultExclude },
});
