/**
 * Test fixture: a minimal but *real* harness-acp-bridge-style HTTP server that answers the
 * lifecycle ping (with its own pid) and then continuously emits credentials through every output
 * path a real server could use — `console`, `stream.write`, `fs.writeSync(1/2)`, and
 * `fs.writevSync(2)` — including split provider tokens, a multi-line PEM private key, and a
 * known sensitive env literal. Used to prove the detached supervisor's fd-level boundary masks
 * the raw log, not just `process.stdout.write`.
 *
 * Fixtures only; never a real secret. Port comes from the config JSON path in
 * HARNESS_ACP_BRIDGE_CONFIG.
 */
import { createServer } from "node:http";
import { readFileSync, writeSync, writevSync } from "node:fs";

const secret = process.env.FAKE_API_KEY || "missing-fake-key-value";
const CRED_SENTINEL = "CREDSENTINEL0123456789abcdef";
let timer = null;
let server = null;

function emitCredentials() {
  process.stdout.write("stdout ordinary 中文😀 ok\n");
  process.stdout.write("SHORTWRITE-KEEP-" + "k".repeat(300) + "\n");
  console.log("console line token=" + secret);
  process.stdout.write("Authorization: Bearer sk-ant-" + CRED_SENTINEL + "\n");
  // fd-level writes bypass any JS stream patch; they must still be trapped by the pipe boundary.
  writeSync(1, "fd-stdout api_key=" + secret + "\n");
  writeSync(2, Buffer.from("fd-stderr secret=" + secret + "\n"));
  writeSync(2, "-----BEGIN RSA PRIVATE KEY-----\nMIIfakebodyline-one\n");
  writeSync(2, "MIIfakebodyline-two\n-----END RSA PRIVATE KEY-----\n");
  writevSync(2, [Buffer.from("writev token="), Buffer.from(secret), Buffer.from(" done\n")]);
}

class HarnessHttpServer {
  constructor(config) { this.config = config || {}; }
  start() {
    return new Promise(resolve => {
      const port = this.config && this.config.port;
      server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, data: { status: "ok", protocol_version: 3, pid: process.pid } }));
      });
      server.listen(port, "127.0.0.1", () => {
        emitCredentials();
        timer = setInterval(emitCredentials, 25);
        resolve({ host: "127.0.0.1", port: server.address().port });
      });
    });
  }
  stop() {
    clearInterval(timer);
    return new Promise(resolve => { if (server) server.close(() => resolve()); else resolve(); });
  }
}

function loadConfig(path) { return path ? JSON.parse(readFileSync(path, "utf8")) : {}; }

export { HarnessHttpServer, loadConfig };
