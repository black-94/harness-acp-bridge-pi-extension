#!/usr/bin/env node
/**
 * Detached server bootstrap for the Pi client.
 *
 * Spawned by `lifecycle.ts` only when no compatible server is listening on a loopback address.
 * Loads the installed server package (or an explicit entry) and starts the HTTP server.
 */
const entry = process.env.HARNESS_ACP_BRIDGE_SERVER_MODULE || "@black942026/harness-acp-bridge-server";

async function main() {
  const mod = await import(entry);
  if (typeof mod.HarnessHttpServer !== "function" || typeof mod.loadConfig !== "function") {
    throw new Error(`server entry ${entry} did not export HarnessHttpServer and loadConfig`);
  }
  const configPath = process.env.HARNESS_ACP_BRIDGE_CONFIG;
  const server = new mod.HarnessHttpServer(configPath ? mod.loadConfig(configPath) : mod.loadConfig());
  const address = await server.start();
  process.stderr.write(`harness-acp-bridge listening at ${address.host}:${address.port}\n`);
  const stop = () => { void server.stop().then(() => process.exit(0)).catch(() => process.exit(1)); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch(error => {
  process.stderr.write(`harness-acp-bridge bootstrap failed: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
