import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, resolve } from "node:path";
import type { BridgeSettings } from "./config.ts";

export const MAX_STARTUP_STDERR_CHARS = 8192;
const sensitiveKey = /token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?key/i;
const sensitiveAssignment = /([A-Za-z0-9_.'"-]*(?:token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?key)[A-Za-z0-9_.'"-]*)(\s*[:=]\s*)([^\n,}]+)/gi;

/** Diagnostics never echo argv or the environment. Mask known secret values too. */
export function redactDiagnostic(text: string, env: Record<string, string>): string {
  for (const [key, value] of Object.entries(env)) {
    if (sensitiveKey.test(key) && value) text = text.split(value).join("[redacted]");
  }
  return text
    .replace(/\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{6,})/gi, "$1 [redacted]")
    .replace(sensitiveAssignment, "$1$2[redacted]")
    // Do not allow stderr to inject terminal control sequences into UI notices.
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function checkPath(label: string, path: string, directory: boolean, mode: number): void {
  try {
    const stat = statSync(path);
    if (directory ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(directory ? "not a directory" : "not a regular file");
    }
    accessSync(path, mode);
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    throw new Error(`${label}: ${path}: ${cause.code ?? cause.message}`);
  }
}

/** Check only unambiguous local paths; wrappers/complex Node argv use stderr diagnostics. */
export function validateLaunch(settings: BridgeSettings, env: Record<string, string>): void {
  const cwd = resolve(settings.cwd);
  checkPath("Invalid bridge cwd", cwd, true, constants.X_OK);
  const { command } = settings;
  if (isAbsolute(command) || command.includes("/")) {
    checkPath("Invalid bridge executable", resolve(cwd, command), false, constants.X_OK);
  } else {
    const candidates = (env.PATH ?? "/usr/bin:/bin").split(delimiter).map(dir => resolve(cwd, dir, command));
    if (!candidates.some(path => {
      try { return statSync(path).isFile() && (accessSync(path, constants.X_OK), true); }
      catch { return false; }
    })) throw new Error(`Bridge executable not found or not executable on PATH: ${command}`);
  }
  if (!["node", "nodejs"].includes(basename(command))) return;
  const entry = settings.args[0];
  if (!entry || entry.startsWith("-")) return;
  checkPath("Invalid bridge Node entry", resolve(cwd, entry), false, constants.R_OK);
}

export function startupFailure(settings: BridgeSettings, error: unknown, stderr = ""): string {
  const reason = error instanceof Error ? error.message : String(error);
  return redactDiagnostic(
    `ACP bridge startup failed (command=${settings.command}; cwd=${settings.cwd}): ${reason}` +
    (stderr.trim() ? `\nstderr (first ${MAX_STARTUP_STDERR_CHARS} chars): ${stderr.trim()}` : ""),
    settings.env,
  );
}
