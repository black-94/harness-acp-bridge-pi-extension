import { defaultExclude, defineConfig } from "vitest/config";

// Default suite: fully self-contained (no sibling `../pi-ask-user` checkout required).
// The real-normalizer cross-check lives in `test/protocol/` and runs only via `npm run test:protocol`.
export default defineConfig({
  test: { exclude: [...defaultExclude, "test/protocol/**"] },
});
