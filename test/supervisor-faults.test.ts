/**
 * Pi supervisor error-branch hardening tests.
 *
 * Drives the *real* detached supervisor directly (plain ESM, not through lifecycle, to avoid the
 * ownership race) with the test-only fault hook, and asserts the fatal branches terminate the
 * owned server, exit non-zero, and never write un-redacted bytes into the log, proof, or its temp
 * file. Also proves short writes are completed and the proof/log metadata is masked when a known
 * secret appears in the log path.
 *
 * Fixtures only; no real secret values.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const bootstrap = resolve(here, "../src/bootstrap.mjs");
const noisyFixture = resolve(here, "fixtures/noisy-http-server.mjs");
const FAKE_ENV_SECRET = "fakeEnvLiteralValue9876543210";

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pi-fault-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function waitDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!alive(pid)) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
  return !alive(pid);
}

function startSupervisor(dir: string, fault?: string): { child: ChildProcess; logPath: string; proofPath: string } {
  const logPath = join(dir, "server.log");
  const proofPath = join(dir, "launch.json");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_API_KEY: FAKE_ENV_SECRET,
    HARNESS_ACP_BRIDGE_SERVER_MODULE: noisyFixture,
    HARNESS_ACP_BRIDGE_LOG: logPath,
    HARNESS_ACP_BRIDGE_PROOF: proofPath,
    HARNESS_ACP_BRIDGE_NONCE: `nonce-${Math.random().toString(16).slice(2)}`,
  };
  delete env.HARNESS_ACP_BRIDGE_CONFIG;
  delete env.HARNESS_ACP_BRIDGE_SERVER_ENTRY;
  if (fault) env.HARNESS_ACP_BRIDGE_SUPERVISOR_FAULT = fault;
  const child = spawn(process.execPath, [bootstrap], { env, stdio: "ignore" });
  children.push(child);
  return { child, logPath, proofPath };
}

function waitExit(child: ChildProcess, timeoutMs = 8000): Promise<number | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.on("exit", code => { clearTimeout(timer); resolve(code); });
  });
}

function readProof(proofPath: string): { launcher_pid: number; server_pid: number | null; log?: string; error?: string } {
  return JSON.parse(readFileSync(proofPath, "utf8"));
}

describe.runIf(existsSync(bootstrap) && process.platform !== "win32")("Pi supervisor fatal error branches", () => {
  for (const fault of ["redactor_error", "disk_fail"]) {
    it(`${fault}: exits non-zero, kills the owned server, and leaves no orphan`, async () => {
      const dir = tempDir();
      const { child, proofPath, logPath } = startSupervisor(dir, fault);
      const code = await waitExit(child);
      expect(code).not.toBeNull();
      expect(code).not.toBe(0);

      expect(existsSync(proofPath)).toBe(true);
      const proof = readProof(proofPath);
      expect(proof.error).toContain(fault === "disk_fail" ? "log write failed" : "redactor failure");
      await waitDead(proof.launcher_pid);
      if (proof.server_pid) await waitDead(proof.server_pid);
      expect(alive(proof.launcher_pid)).toBe(false);
      if (proof.server_pid) expect(alive(proof.server_pid)).toBe(false);

      expect(readdirSync(dir).some(name => name.endsWith(".tmp"))).toBe(false);
      if (existsSync(logPath)) expect(readFileSync(logPath, "utf8")).not.toContain(FAKE_ENV_SECRET);
      expect(readFileSync(proofPath, "utf8")).not.toContain(FAKE_ENV_SECRET);
    });
  }

  it("short_write: completes the sanitized buffer so a long ordinary line survives intact", async () => {
    const dir = tempDir();
    const { child, logPath } = startSupervisor(dir, "short_write");
    await new Promise(resolve => setTimeout(resolve, 500));
    child.kill("SIGTERM");
    const code = await waitExit(child);
    expect(code).not.toBeNull();

    const raw = readFileSync(logPath, "utf8");
    expect(raw).toContain("SHORTWRITE-KEEP-" + "k".repeat(300) + "\n");
    expect(raw).not.toContain(FAKE_ENV_SECRET);
  });

  it("masks a known secret that appears in the log path before it is persisted in the proof", async () => {
    const dir = tempDir(`pi-fault-${FAKE_ENV_SECRET}-`);
    const { child, proofPath } = startSupervisor(dir, "disk_fail");
    const code = await waitExit(child);
    expect(code).not.toBe(0);
    const rawProof = readFileSync(proofPath, "utf8");
    expect(rawProof).not.toContain(FAKE_ENV_SECRET);
    expect(JSON.parse(rawProof).log).not.toContain(FAKE_ENV_SECRET);
  });
});
