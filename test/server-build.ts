/**
 * Resolve the built server the client integration/lifecycle tests must start.
 *
 * Prefer the repo checkout's build (`../server/dist/index.js`) so integration runs against the
 * in-repo server, and fall back to the installed dependency when the parent checkout is absent (an
 * isolated subrepo CI checkout). The client is protocol-4 only, so a build that advertises an older
 * protocol is not usable; the server-spawning suites are skipped until the server is rebuilt with
 * the new contract rather than silently running against the old installed dependency.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const serverDir = process.env.ACP_BRIDGE_SERVER_DIR ? resolve(process.env.ACP_BRIDGE_SERVER_DIR) : resolve(here, "../../server");
export const fakeHarness = join(serverDir, "test/fixtures/fake-acp-harness.mjs");

function distIsProtocol4(distRoot: string): boolean {
  try { return /PROTOCOL_VERSION\s*=\s*4\b|protocol_version:\s*4\b/.test(readFileSync(join(distRoot, "logic", "service.js"), "utf8")); }
  catch { return false; }
}

export function newContractServerEntry(): string | null {
  const repo = join(serverDir, "dist");
  if (distIsProtocol4(repo)) return join(repo, "index.js");
  const installed = join(here, "..", "node_modules", "@black942026", "harness-acp-bridge-server", "dist");
  if (distIsProtocol4(installed)) return join(installed, "index.js");
  return null;
}

/**
 * The `hacpd` CLI of a protocol-4 build (`dist/main.js`), for exercising the PATH-command launch
 * path. Returns null when no protocol-4 build is present (the command suites then skip).
 */
export function newContractServerCli(): string | null {
  const repo = join(serverDir, "dist");
  if (distIsProtocol4(repo) && existsSync(join(repo, "main.js"))) return join(repo, "main.js");
  const installed = join(here, "..", "node_modules", "@black942026", "harness-acp-bridge-server", "dist");
  if (distIsProtocol4(installed) && existsSync(join(installed, "main.js"))) return join(installed, "main.js");
  return null;
}

/** True when a server with the new contract can actually be started for an integration test. */
export function serverSpawningAvailable(): boolean {
  return existsSync(fakeHarness) && newContractServerEntry() !== null;
}
