#!/usr/bin/env node
/**
 * Orphan watchdog preloaded into a `hacpd` CLI server process.
 *
 * The `hacpd` CLI runs the HTTP server in-process and does **not** read stdin, so it has no
 * built-in way to notice that the detached logging supervisor that launched it has gone away.
 * The supervisor therefore spawns the CLI as `node --import <this file> <hacpd-script>` with the
 * CLI as the *direct* child, so:
 *
 *  - the supervisor's `child.pid` **is** the answering ping pid (exact ownership proof), and
 *  - closing the supervisor-to-child stdin pipe (supervisor exit, including SIGKILL) reaches EOF
 *    here, and this watchdog stops the server instead of orphaning it.
 *
 * It deliberately only reacts to our stdin closing: the supervisor holds that pipe open for as
 * long as it lives, and the CLI itself never touches stdin. Stopping routes through the CLI's own
 * SIGTERM handler (graceful `server.stop()`), with a SIGKILL backstop so a hung stop cannot leak.
 *
 * Plain ESM only — no TypeScript loader.
 */
let stopping = false;
let escalating = false;

/** Unref'd SIGKILL backstop, armed once, so a hung graceful stop cannot leak the process. */
function escalate() {
  if (escalating) return;
  escalating = true;
  const backstop = setTimeout(() => { try { process.kill(process.pid, "SIGKILL"); } catch { /* gone */ } }, 3000);
  backstop.unref();
}

/** The supervisor went away (our stdin hit EOF): ask the CLI to stop, then escalate if it hangs. */
function stop() {
  if (stopping) return;
  stopping = true;
  try { process.kill(process.pid, "SIGTERM"); } catch { /* already gone */ }
  escalate();
}

process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();

/**
 * An explicit stop signal asks the CLI to shut down gracefully. Mark ourselves as already
 * stopping (so destroying our stdin below cannot trigger another self-SIGTERM through `stop`),
 * release the stdin handle so the event loop can drain once the CLI's `server.stop()` resolves —
 * the CLI sets only `process.exitCode` and would otherwise stay alive on this still-open
 * (supervisor-held) pipe — and arm the backstop once.
 */
function onSignal() {
  stopping = true;
  try { process.stdin.destroy(); } catch { /* ignore */ }
  escalate();
}
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);
