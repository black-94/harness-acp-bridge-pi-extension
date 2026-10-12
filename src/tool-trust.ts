/** Verify the callable interaction tool against Pi's provenance and its installed manifest. */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { satisfies, valid, validRange } from "semver";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const ASK_USER_PACKAGE = "@black942026/pi-ask-user";
export interface AskUserPolicy {
  toolName: string;
  sources: string[];
  minVersion: string;
  minVersionExclusive: boolean;
}
export function defaultAskUserPolicy(): AskUserPolicy {
  return { toolName: "ask_user", sources: [`npm:${ASK_USER_PACKAGE}`], minVersion: "0.1.4", minVersionExclusive: false };
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function parseAskUserPolicy(value: unknown): AskUserPolicy {
  const defaults = defaultAskUserPolicy();
  if (value === undefined) return defaults;
  if (!record(value)) throw new Error("askUser must be an object");
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`unknown askUser setting: ${key}`);
  }
  const toolName = value.toolName !== undefined ? value.toolName : defaults.toolName;
  const sources = value.sources !== undefined ? value.sources : defaults.sources;
  const minVersion = value.minVersion !== undefined ? value.minVersion : defaults.minVersion;
  const minVersionExclusive = value.minVersionExclusive !== undefined ? value.minVersionExclusive : defaults.minVersionExclusive;
  if (typeof toolName !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(toolName)) throw new Error("askUser.toolName must be an exact tool name");
  if (!Array.isArray(sources) || sources.some(source => typeof source !== "string" || !source.trim() || source !== source.trim() || source.includes("\0") || (source.startsWith("path:") && !isAbsolute(source.slice(5))))) {
    throw new Error("askUser.sources must be a list of exact sources (path: entries require absolute paths)");
  }
  if (typeof minVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(minVersion) || !valid(minVersion)) throw new Error("askUser.minVersion must be a full SemVer version");
  if (typeof minVersionExclusive !== "boolean") throw new Error("askUser.minVersionExclusive must be boolean");
  return { toolName, sources: [...sources] as string[], minVersion, minVersionExclusive };
}

/** An unversioned npm allowlist entry accepts selectors of that exact package, never prefixes/aliases. */
function matchesSource(allowed: string, source: string, path: string): boolean {
  if (allowed.startsWith("path:")) {
    try { return realpathSync(allowed.slice(5)) === path; } catch { return false; }
  }
  if (allowed === source) return true;
  if (allowed !== `npm:${ASK_USER_PACKAGE}` || !source.startsWith(`${allowed}@`)) return false;
  const selector = source.slice(allowed.length + 1);
  return Boolean(selector && (validRange(selector) !== null || /^[A-Za-z][A-Za-z0-9_-]*$/.test(selector)));
}
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export type ToolTrust = { trusted: true; toolName: string; version: string } | { trusted: false; reason: string };
export function checkAskUserTool(tool: ToolInfo, policy: AskUserPolicy): ToolTrust {
  const refuse = (reason: string): ToolTrust => ({ trusted: false, reason });
  if (tool.name !== policy.toolName) return refuse("tool name does not match the configured name");
  const source = tool.sourceInfo;
  if (!record(source) || typeof source.source !== "string" || typeof source.path !== "string" || !isAbsolute(source.path) ||
      !["package", "top-level"].includes(String(source.origin)) || !["user", "project", "temporary"].includes(String(source.scope))) {
    return refuse("Pi source metadata is missing or invalid");
  }
  try {
    // Resolve real paths: an entry symlink must not escape the package that Pi recorded.
    const path = realpathSync(source.path);
    if (!statSync(path).isFile()) return refuse("extension entry is not a regular file");
    if (!policy.sources.some(allowed => matchesSource(allowed, source.source as string, path))) return refuse("tool source is not allowlisted");
    if (typeof source.baseDir !== "string" || !isAbsolute(source.baseDir)) return refuse("Pi source base directory is missing");
    const root = realpathSync(source.baseDir);
    if (!inside(root, path)) return refuse("extension entry is outside its recorded source directory");
    let dir = dirname(path);
    while (inside(root, dir)) {
      let text: string;
      try {
        const manifestPath = realpathSync(join(dir, "package.json"));
        if (!inside(root, manifestPath) || !statSync(manifestPath).isFile()) return refuse("package manifest is outside its recorded source directory or not a file");
        text = readFileSync(manifestPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse("installed package manifest is unreadable");
        if (dir === root) break;
        dir = dirname(dir); continue;
      }
      const manifest: unknown = JSON.parse(text);
      // Stop at the nearest package boundary, not at an unrelated ancestor's matching name.
      if (!record(manifest) || manifest.name !== ASK_USER_PACKAGE) return refuse(`installed package is not ${ASK_USER_PACKAGE}`);
      const version = manifest.version;
      if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) || !valid(version)) return refuse("installed package has no valid version");
      const range = `${policy.minVersionExclusive ? ">" : ">="}${policy.minVersion}`;
      if (!satisfies(version, range)) return refuse(`installed ${ASK_USER_PACKAGE} version ${version} does not satisfy ${range}`);
      // A pinned npm source cannot claim one version while the actual package reports another.
      if (source.source.startsWith(`npm:${ASK_USER_PACKAGE}@`)) {
        const selector = source.source.slice(`npm:${ASK_USER_PACKAGE}@`.length);
        if (validRange(selector) !== null && !satisfies(version, selector)) return refuse("installed version does not match the recorded npm selector");
      }
      return { trusted: true, toolName: tool.name, version };
    }
    return refuse("no installed package manifest within the recorded source directory");
  } catch { return refuse("tool source path or package manifest could not be verified"); }
}

/** Look up provenance fresh for every invocation; never trust a prior runtime after reload. */
export class AskUserToolVerifier {
  constructor(private readonly getAllTools: () => readonly ToolInfo[], private readonly policy: AskUserPolicy = defaultAskUserPolicy()) {}
  get toolName(): string { return this.policy.toolName; }
  verify(): ToolTrust {
    try {
      const matches = this.getAllTools().filter(tool => tool.name === this.policy.toolName);
      if (matches.length !== 1) return { trusted: false, reason: matches.length ? "ambiguous tool registration" : "configured tool has no source metadata" };
      return checkAskUserTool(matches[0], this.policy);
    } catch { return { trusted: false, reason: "Pi tool source metadata is unavailable" }; }
  }
}
