#!/usr/bin/env node
/**
 * Detached logging supervisor for the Pi client.
 *
 * Spawned (detached, no inherited stdio) by `lifecycle.ts` when no compatible server is
 * listening. It launches the *actual* server as a child whose stdout/stderr are **pipes** — never
 * the log file — reads both streams through independent bounded stream redactors, and appends the
 * masked bytes to the persisted log. Because the real fds are pipes, every output path is covered:
 * `console`, `stream.write`, `fs.writeSync(1/2)`, `fs.writev`, native modules, and dynamic-import
 * / runtime diagnostics. The supervisor owns the server for its whole lifetime and keeps running
 * (and masking) after the client that started it has exited.
 *
 * It writes a private proof file (mode 0600, atomic) tying the caller-supplied nonce to its own
 * pid and the server child's pid, so the client can prove the answering server is its grandchild.
 *
 * Invariants:
 *  - Never write un-redacted bytes anywhere, including the proof/metadata: the log path and any
 *    error text are masked with the same known-secret set before serialization.
 *  - A redactor failure or a disk write failure is fatal to this *owned* server: the child is
 *    terminated and this process exits non-zero. It never falls through to raw bytes and never
 *    retries forever. The drains keep consuming so the server never blocks on a full pipe.
 *  - If the proof cannot be persisted, the supervisor fails closed (kills its own server) rather
 *    than staying ready, so a client can never mistake it for a peer and reclaim a live server.
 *  - Writes loop over short/zero progress with EINTR retry, so a sanitized buffer is either fully
 *    written or reported as a failure.
 *  - At EOF the held tails of both streams are flushed (masked) before the log fd is closed.
 *
 * Plain ESM only — no TypeScript loader.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSecrets, redactText, StreamRedactor } from "./redact.mjs";

const EMPTY = Buffer.alloc(0);
const DEFAULT_SERVER_MODULE = "@black942026/harness-acp-bridge-server";

function message(error) { return error instanceof Error ? error.message : String(error); }

const rawLogPath = process.env.HARNESS_ACP_BRIDGE_LOG;
const rawProofPath = process.env.HARNESS_ACP_BRIDGE_PROOF;
const rawNonce = process.env.HARNESS_ACP_BRIDGE_NONCE;
if (!rawLogPath || !rawProofPath || !rawNonce) {
  process.stderr.write("harness-acp-bridge bootstrap: missing log/proof/nonce environment\n");
  process.exit(1);
}
const logPath = rawLogPath;
const proofPath = rawProofPath;
const nonce = rawNonce;
const entry = process.env.HARNESS_ACP_BRIDGE_SERVER_MODULE || DEFAULT_SERVER_MODULE;
const configPath = process.env.HARNESS_ACP_BRIDGE_CONFIG;
const runner = fileURLToPath(new URL("./server-runner.mjs", import.meta.url));
const secrets = collectSecrets(process.env);

/**
 * Test-only fault injection; inert unless exactly one known value is set. Lets the acceptance
 * suite drive the fatal error branches (redactor exception / short write / disk failure) through
 * the real detached supervisor.
 */
const FAULT = process.env.HARNESS_ACP_BRIDGE_SUPERVISOR_FAULT || "";
let faultArmed = FAULT === "redactor_error" || FAULT === "short_write" || FAULT === "disk_fail";

let child = null;
let logFd = -1;
let fatal = null;
let finished = false;
let childExited = false;
let exitCode = 0;

/** The proof payload with the free-text fields (log path, error) masked before it touches disk. */
function sanitizedProof(error) {
  const data = {
    nonce,
    launcher_pid: process.pid,
    server_pid: child && child.pid ? child.pid : null,
    log: redactText(logPath, secrets),
    started_at: new Date().toISOString(),
  };
  if (error !== undefined) data.error = redactText(error, secrets);
  return data;
}

/** Write the sanitized proof atomically. Returns false when it could not be persisted. */
function writeProof(error) {
  try {
    const temporary = `${proofPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(sanitizedProof(error))}\n`, { mode: 0o600 });
    renameSync(temporary, proofPath);
    return true;
  } catch { return false; }
}

try { mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 }); } catch { /* openSync reports it */ }
try { logFd = openSync(logPath, "a", 0o600); }
catch (error) { writeProof(`could not open log: ${message(error)}`); process.exit(1); }

const stdoutRedactor = new StreamRedactor(secrets, "utf8");
const stderrRedactor = new StreamRedactor(secrets, "utf8");

/** Write the whole sanitized buffer, retrying EINTR and looping over short/zero writes. */
function writeFully(bytes) {
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    let length = bytes.length - offset;
    if (first && faultArmed && FAULT === "disk_fail") { faultArmed = false; throw new Error("injected disk failure"); }
    if (first && faultArmed && FAULT === "short_write") { faultArmed = false; length = Math.max(1, length >> 1); }
    first = false;
    let written;
    try { written = writeSync(logFd, bytes, offset, length); }
    catch (error) { if (error && error.code === "EINTR") continue; throw error; }
    if (written <= 0) throw new Error(`write made no progress (${written})`);
    offset += written;
  }
}

function writeDisk(bytes) {
  if (bytes.length === 0 || fatal) return;
  try { writeFully(bytes); }
  catch (error) { goFatal(`log write failed: ${message(error)}`); }
}

/** Redact one chunk. A redactor exception is fatal for the owned server — never raw, never silent. */
function drain(redactor, chunk) {
  if (fatal) return;
  let out;
  try {
    if (faultArmed && FAULT === "redactor_error") { faultArmed = false; throw new Error("injected redactor failure"); }
    out = redactor.push(chunk);
  } catch (error) { goFatal(`redactor failure: ${message(error)}`); return; }
  writeDisk(out);
}

function drainEnd(redactor) {
  if (fatal) return;
  let tail;
  try { tail = redactor.flush(); } catch (error) { goFatal(`redactor failure: ${message(error)}`); return; }
  writeDisk(tail);
}

function finish(code) {
  if (finished) return;
  finished = true;
  try { if (logFd >= 0) closeSync(logFd); } catch { /* ignore */ }
  process.exit(fatal ? 1 : (code === undefined ? exitCode : code));
}

/** A fatal logging failure: record it (sanitized), take down the owned server, exit non-zero. */
function goFatal(reason) {
  if (fatal) return;
  fatal = reason;
  writeProof(reason);
  if (child && child.pid) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
  const backstop = setTimeout(() => { if (child && child.pid) { try { child.kill("SIGKILL"); } catch { /* gone */ } } finish(1); }, 2000);
  backstop.unref();
}

const env = { ...process.env, HARNESS_ACP_BRIDGE_SERVER_MODULE: entry };
if (configPath) env.HARNESS_ACP_BRIDGE_CONFIG = configPath;
try {
  child = spawn(process.execPath, [runner], { stdio: ["pipe", "pipe", "pipe"], env });
} catch (error) {
  writeProof(`could not spawn server: ${message(error)}`);
  process.exit(1);
}

let outEnded = !child.stdout;
let errEnded = !child.stderr;
const maybeFinish = () => { if (outEnded && errEnded && childExited) finish(); };

child.on("error", error => {
  goFatal(`server spawn error: ${message(error)}`);
  outEnded = true; errEnded = true; childExited = true; maybeFinish();
});
if (child.stdin) child.stdin.on("error", () => { /* ignore EPIPE */ });
if (child.stdout) {
  child.stdout.on("data", chunk => drain(stdoutRedactor, chunk));
  child.stdout.on("end", () => { drainEnd(stdoutRedactor); outEnded = true; maybeFinish(); });
}
if (child.stderr) {
  child.stderr.on("data", chunk => drain(stderrRedactor, chunk));
  child.stderr.on("end", () => { drainEnd(stderrRedactor); errEnded = true; maybeFinish(); });
}
child.on("exit", (code, signal) => { childExited = true; exitCode = code === null ? (signal ? 1 : 0) : code; maybeFinish(); });
child.on("close", () => { childExited = true; maybeFinish(); });

// Fail closed: a supervisor that cannot persist its proof must not stay ready, or the client could
// mistake a live server for a peer and reclaim it.
if (!writeProof()) goFatal("could not persist launch proof");

const forward = signal => {
  if (child && child.pid) { try { child.kill(signal); } catch { /* gone */ } }
  const backstop = setTimeout(() => { if (child && child.pid) { try { child.kill("SIGKILL"); } catch { /* gone */ } } }, 3000);
  backstop.unref();
};
process.once("SIGTERM", () => forward("SIGTERM"));
process.once("SIGINT", () => forward("SIGINT"));
