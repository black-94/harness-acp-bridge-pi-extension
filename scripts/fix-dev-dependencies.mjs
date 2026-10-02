// Pi 1.0.0's shrinkwrap bypasses npm overrides, including during npm ci.
// Patch only the affected development package; never run this on npm consumers.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const key = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
const target = join(root, key);
const version = "5.0.12";
const resolved = `https://registry.npmjs.org/brace-expansion/-/brace-expansion-${version}.tgz`;
const integrity = "sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==";
const lockPath = join(root, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const record = lock.packages[key];
if (!record) throw new Error("Pi development dependency missing from lockfile; run npm install first");
const installed = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
if (installed.version !== version) {
  if (installed.version !== "5.0.9") throw new Error(`Unexpected brace-expansion ${installed.version}; review whether the workaround is still needed`);
  if (realpathSync(target) !== target) throw new Error("Refusing to patch a symlinked development dependency");
  const temp = mkdtempSync(join(tmpdir(), "pi-acp-dev-deps-"));
  let stage;
  try {
    writeFileSync(join(temp, "package.json"), '{"name":"pi-acp-dev-deps-patch","version":"0.0.0","private":true}\n');
    const npm = process.env.npm_execpath;
    const result = spawnSync(npm ? process.execPath : "npm", [
      ...(npm ? [npm] : []), "install",
      "--ignore-scripts", "--save-exact", "--package-lock=true", "--omit=dev", "--no-audit", "--no-fund",
      "--registry=https://registry.npmjs.org/", `brace-expansion@${version}`,
    ], { cwd: temp, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Patched package install failed (${result.status})`);
    const fetched = JSON.parse(readFileSync(join(temp, "package-lock.json"), "utf8"))
      .packages["node_modules/brace-expansion"];
    if (!fetched || fetched.version !== version || fetched.resolved !== resolved || fetched.integrity !== integrity) throw new Error("Patched package integrity does not match the reviewed registry release");
    stage = mkdtempSync(join(dirname(target), ".brace-expansion-patch-"));
    cpSync(join(temp, "node_modules", "brace-expansion"), join(stage, "package"), { recursive: true });
    renameSync(target, join(stage, "original"));
    try { renameSync(join(stage, "package"), target); }
    catch (error) { renameSync(join(stage, "original"), target); throw error; }
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}
// Keep the root audit record aligned with the actual patched package, not merely
// reporting zero vulnerabilities while the shrinkwrapped old files remain.
if (record.version !== version || record.resolved !== resolved || record.integrity !== integrity) {
  Object.assign(record, { version, resolved, integrity });
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}
if (!existsSync(join(target, "dist"))) throw new Error("Patched dependency is incomplete");
console.log(`Pi development dependency brace-expansion@${version} verified`);
