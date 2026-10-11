#!/usr/bin/env node
/**
 * The actual server process for the Pi client, launched by the detached logging supervisor
 * (`bootstrap.mjs`).
 *
 * Its stdout and stderr are **pipes owned by the supervisor** — never the log file — so every
 * output path (console, `stream.write`, `fs.writeSync`/`fs.writev`, native modules, runtime and
 * dynamic-import diagnostics) is captured and masked before it reaches disk. This process does
 * no redaction itself and never touches the persisted log.
 *
 * It exits when the supervisor goes away (our stdin pipe reaches EOF) or a termination signal
 * arrives, so a killed supervisor can never orphan a running server. Plain ESM only — it runs
 * under the package's minimum Node version without any TypeScript loader.
 */
const DEFAULT_SERVER_MODULE = "@black942026/harness-acp-bridge-server";
const entry = process.env.HARNESS_ACP_BRIDGE_SERVER_MODULE || DEFAULT_SERVER_MODULE;
const configPath = process.env.HARNESS_ACP_BRIDGE_CONFIG;

let server = null;
let stopping = false;
let failed = false;

function stop() {
  if (stopping) return;
  stopping = true;
  void Promise.resolve(server ? server.stop() : undefined).then(() => process.exit(failed ? 1 : 0), () => process.exit(1));
}

process.once("SIGTERM", stop);
process.once("SIGINT", stop);
// Parent watchdog: the supervisor holds our stdin open and closes it when it exits, so EOF means
// the supervisor is gone and we must not linger as an orphan.
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();

async function main() {
  const mod = await import(entry);
  if (typeof mod.HarnessHttpServer !== "function" || typeof mod.loadConfig !== "function") {
    throw new Error(`server entry ${entry} did not export HarnessHttpServer and loadConfig`);
  }
  server = new mod.HarnessHttpServer(configPath ? mod.loadConfig(configPath) : mod.loadConfig());
  const address = await server.start();
  process.stderr.write(`harness-acp-bridge listening at ${address.host}:${address.port}\n`);
}

main().catch(error => {
  failed = true;
  process.stderr.write(`harness-acp-bridge bootstrap failed: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
  // Release the stdin watchdog so a failed import cannot keep this process (and its supervisor)
  // alive; the process then exits once stderr has drained.
  process.stdin.removeAllListeners("end");
  process.stdin.removeAllListeners("close");
  process.stdin.destroy();
});
