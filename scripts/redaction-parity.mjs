#!/usr/bin/env node
/**
 * Redaction parity harness: Pi extension <-> server.
 *
 * Loads the pure redaction module from this package (`src/redact.mjs`) and from the canonical
 * server build, then runs one shared battery of representative cases (sensitive values of every
 * shape, deep/opaque containers, escaped bodies, provider/Basic continuation, JSON suffix recovery,
 * UTF-8/latin1 byte cuts, BOM/ANSI, unknown-text preservation, long-literal KEEP). It asserts the
 * two modules are **byte-exact** for the same inputs/secrets/chunks/encoding for both the
 * non-streaming and the streaming APIs, plus a bounded perf sanity check.
 *
 * The three packages stay consistent transitively: this package is pinned against the server here,
 * and the MCP client is pinned against the same server build by its own copy of this harness.
 *
 * Dev-only; not shipped (`scripts/` is outside the published `files`). Usage — build the server and
 * run from this package:
 *   npm run parity
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** This package's directory (`<repo>/pi-extension`). */
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(packageDir);
const LOG = "/tmp/redaction-parity-pi.log";
const lines = [];
function log(line) { lines.push(line); process.stdout.write(`${line}\n`); }

/**
 * The canonical server build: the sibling checkout first (catches drift before publishing), then
 * the installed dependency (so this harness still works when the repo is not checked out beside it).
 */
function serverRedact() {
  const candidates = [
    join(repoRoot, "server/dist/redact/redact.js"),
    join(packageDir, "node_modules/@black942026/harness-acp-bridge-server/dist/redact/redact.js"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`no server redaction build found; build it with "npm run build" in server/, or install the dependency:\n  ${candidates.join("\n  ")}`);
}

const MODULES = [
  ["pi", join(packageDir, "src/redact.mjs")],
  ["server", serverRedact()],
];
log(`modules: ${MODULES.map(([name, path]) => `${name}=${path}`).join("  ")}`);

const loaded = [];
for (const [name, path] of MODULES) {
  const mod = await import(pathToFileURL(path).href);
  for (const fn of ["redactText", "redactValue", "redactBytes", "StreamRedactor", "isSensitiveKeyName"]) {
    if (typeof mod[fn] !== "function") throw new Error(`${name}: ${path} is missing export ${fn}`);
  }
  loaded.push([name, mod]);
}

let failures = 0;
function fail(name, detail) { failures++; log(`FAIL ${name}: ${detail}`); }

/** Both modules must yield the same string for a text case. */
function parityText(name, input, secrets = []) {
  const outputs = loaded.map(([n, m]) => { try { return m.redactText(input, secrets); } catch (e) { return `ERR:${n}:${e.message}`; } });
  if (new Set(outputs).size !== 1) return fail(name, `text mismatch: ${JSON.stringify(outputs.map(o => o.slice(0, 80)))}`);
  log(`ok   text  ${name} (${outputs[0].length} chars)`);
  return outputs[0];
}

function parityValue(name, input, secrets = []) {
  const outputs = loaded.map(([n, m]) => { try { return JSON.stringify(m.redactValue(input, secrets)); } catch (e) { return `ERR:${n}:${e.message}`; } });
  if (new Set(outputs).size !== 1) return fail(name, `value mismatch: ${JSON.stringify(outputs.map(o => o.slice(0, 80)))}`);
  log(`ok   value ${name} (${outputs[0].length} chars)`);
  return outputs[0];
}

function parityBytes(name, input, secrets = []) {
  const outputs = loaded.map(([n, m]) => { try { return m.redactBytes(input, secrets); } catch (e) { return Buffer.from(`ERR:${n}:${e.message}`); } });
  const first = outputs[0];
  if (!outputs.every(o => Buffer.isBuffer(o) && o.equals(first))) return fail(name, "bytes mismatch across modules");
  log(`ok   bytes ${name} (${first.length} bytes)`);
  return first;
}

/** Both modules must yield byte-identical streamed output for identical chunks/encoding. */
function parityStream(name, parts, secrets = [], charset = "latin1") {
  const run = mod => {
    const r = new mod.StreamRedactor(secrets, charset);
    const out = [];
    for (const part of parts) out.push(r.push(Buffer.isBuffer(part) ? part : Buffer.from(part, charset)));
    out.push(r.flush());
    return Buffer.concat(out);
  };
  const outputs = loaded.map(([n, m]) => { try { return run(m); } catch (e) { return Buffer.from(`ERR:${n}:${e.message}`); } });
  const first = outputs[0];
  if (!outputs.every(o => o.equals(first))) return fail(name, "stream mismatch across modules");
  log(`ok   stream ${name} (${first.length} bytes)`);
  return first.toString(charset);
}

// ---------------------------------------------------------------------------
// Non-streaming battery
// ---------------------------------------------------------------------------
log("== non-streaming ==");
const SENSITIVE_ALL = '{"token":424242,"secret":null,"credentials":{"label":"opaqueSECRET1","other":"opaqueSECRET2"},"cookie":["opaqueCOOKIE1","opaqueCOOKIE2"],"password":true,"public_key":"keep"}';
{
  const out = parityValue("sensitive-all-types", JSON.parse(SENSITIVE_ALL));
  for (const leak of ["opaqueSECRET1", "opaqueCOOKIE1", "424242"]) if (out.includes(leak)) fail("sensitive-all-types", `leaked ${leak}`);
}
parityValue("deep-plain-50", JSON.parse('{"a":1,"b":[1,2,{"c":"hello 世界😀"}]}'));
{
  const wrap = (d, inner) => { let t = inner; for (let i = 0; i < d; i++) t = `{"wrap${i}":${t}}`; return t; };
  const inner = '{"credentials":{"label":"DEEP_OPAQUE_SECRET"},"cookie":["DEEP_COOKIE_SECRET"],"token":424242,"public_key":"KEEP"}';
  for (const d of [12, 200]) {
    const out = parityText(`deep-${d}`, wrap(d, inner));
    if (out.includes("DEEP_OPAQUE_SECRET") || out.includes("DEEP_COOKIE_SECRET")) fail(`deep-${d}`, "leaked");
  }
}
parityText("escaped-body", '{"text":"{\\"token\\":\\"escaped-secret-123456\\"}","note":"keep me"}');
parityText("escaped-newline-emoji", '{"text":"line1\\nsecret=SECRETVALUE123\\nemoji:\\ud83d\\ude00 end"}');
parityText("unknown-ordinary-preserved", '{"max_tokens":100,"token_count":5,"id":"tok_1","text":"hello 世界 😀"}');
parityText("ansi-preserved", "\u001b[31mplain \u001b[0m token=SECRETVALUE123 世界😀");
parityText("url-and-auth", "https://user:s3cr3t@example.com/x?access_token=abc&x=1 Authorization: Bearer abcdefghijklmnopqrstuv");
parityText("literal-overlap", "https://u:abcTAIL@host", ["TAIL@host"]);
parityText("provider-single-chunk", `x sk-ant-${"A".repeat(30)} y and pypi-${"B".repeat(20)} z`);
parityText("pem-public-untouched", "x -----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\ny");
parityText("pem-private-masked", "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\nDEFghi\n-----END RSA PRIVATE KEY-----\nafter");
parityText("unterminated-json", '{"token":"secret-without-close');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
parityBytes("bytes-plain-utf8-roundtrip", Buffer.from('{"text":"汉字😀 plain"}\n'));
{
  const out = parityBytes("bytes-bom-sensitive", Buffer.concat([BOM, Buffer.from('{"token":"secret-value"}\n')]), []);
  if (!out.subarray(0, 3).equals(BOM)) fail("bytes-bom-sensitive", "BOM not preserved");
}
{
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("token=SECRETVALUE")]);
  const out = parityBytes("bytes-invalid-utf8", buf, []);
  if (!out.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) fail("bytes-invalid-utf8", "invalid bytes not preserved");
}
{
  const secret = "秘密值SECRET123";
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`token=${secret}`, "utf8")]);
  const out = parityBytes("bytes-invalid-utf8-literal", buf, [secret]);
  if (out.toString("latin1").includes(Buffer.from(secret, "utf8").toString("latin1"))) fail("bytes-invalid-utf8-literal", "leaked literal");
}

// ---------------------------------------------------------------------------
// Streaming battery
// ---------------------------------------------------------------------------
log("== streaming ==");
const LONG = "S".repeat(70000);
{
  const out = parityStream("stream-long-kv-1chunk", [`token="${LONG}" suffix KEEP\n`]);
  if (out !== 'token="[REDACTED]" suffix KEEP\n') fail("stream-long-kv-1chunk", `unexpected: ${JSON.stringify(out.slice(0, 60))}`);
}
parityStream("stream-long-kv-split", [`token="${LONG}`, `" suffix KEEP\nafter\n`]);
parityStream("stream-long-json-value", [`{"token":"${LONG}"} suffix KEEP\n`]);
parityStream("stream-escaped-quote-resume", [`token="${LONG}\\"inner" suffix KEEP\n`]);
{
  const out = parityStream("stream-long-object-container", [`prefix {"credentials":{"label":"OPAQUE_LEAK_SENTINEL${"A".repeat(100000)}"},"public_key":"KEEP"}\n`]);
  if (out.includes("OPAQUE_LEAK_SENTINEL") || !out.includes('"public_key":"KEEP"')) fail("stream-long-object-container", "container leak/keep");
}
{
  const out = parityStream("stream-long-array-container", [`{"cookie":["OPAQUE_COOKIE_SENTINEL${"B".repeat(100000)}"],"public_key":"KEEP"}\n`]);
  if (out.includes("OPAQUE_COOKIE_SENTINEL") || !out.includes('"public_key":"KEEP"')) fail("stream-long-array-container", "container leak/keep");
}
parityStream("stream-1mib-kv-keepmarker", ['token="' + "A".repeat(1024 * 1024), '" KEEPMARKER\n']);
for (const [name, first, continuation] of [
  ["sk-ant", `sk-ant-${"A".repeat(70000)}`, "-SENTINEL_PROVIDER_SUFFIX"],
  ["pypi", `pypi-${"B".repeat(70000)}`, "-pypi_SUFFIX"],
  ["xox", `xoxb-${"D".repeat(70000)}`, "-extra-tail"],
  ["github_pat", `github_pat_${"E".repeat(70000)}`, "_gh_suffix"],
]) {
  const out = parityStream(`stream-provider-${name}`, [first, `${continuation} KEEPMARK\n`]);
  if (out.includes(continuation) || !out.includes("KEEPMARK")) fail(`stream-provider-${name}`, "continuation leak/keep");
}
parityStream("stream-basic-padding", [`x Basic ${"d".repeat(70000)}==`, " tail KEEP\n"]);
parityStream("stream-jwt-dots", [`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"S".repeat(70000)}`, " tail KEEP\n"]);
parityStream("stream-pem-foreign-end", [
  Buffer.from("-----BEGIN PRIVATE KEY-----\n" + "A".repeat(10000)),
  Buffer.from("-----END EC PARAMETERS-----\nSECRETLEAKBODY\n-----END PRIVATE KEY-----\nZ"),
], [], "latin1");
parityStream("stream-unterminated-pem-eof", ["before\n-----BEGIN PRIVATE KEY-----\nSECRETBODY\nmore\n"]);
{
  // multibyte stream split at every 7 bytes must round-trip byte-exact
  const buffer = Buffer.from("prefix 中文😀 end".repeat(2000));
  const parts = [];
  for (let i = 0; i < buffer.length; i += 7) parts.push(buffer.subarray(i, i + 7));
  const out = parityStream("stream-utf8-byte-split-roundtrip", parts, [], "utf8");
  const expected = buffer.toString("utf8");
  if (out !== expected) fail("stream-utf8-byte-split-roundtrip", "round-trip mismatch");
}
{
  const secret = "秘密令牌value1";
  const buffer = Buffer.from(`xx${secret}yy`);
  const parts = [];
  for (let i = 0; i < buffer.length; i++) parts.push(buffer.subarray(i, i + 1));
  const out = parityStream("stream-known-multibyte-literal", parts, [secret], "utf8");
  if (out.includes(secret)) fail("stream-known-multibyte-literal", "leaked");
}
{
  const buf = Buffer.concat([Buffer.from([0xc3, 0x28, 0xff]), Buffer.from(" token=SECRETVALUE123")]);
  parityStream("stream-invalid-utf8-preserved", [buf], [], "utf8");
}
{
  // A decoded journal line (bytes that arrive base64-encoded on disk) must redact identically.
  const wire = Buffer.from('{"access_token":"base64SECRET123456","note":"keep 中文😀"}\n', "utf8");
  const decoded = Buffer.from(wire.toString("base64"), "base64");
  const out = parityBytes("bytes-decoded-base64", decoded, []);
  if (out.toString("utf8").includes("base64SECRET123456")) fail("bytes-decoded-base64", "leaked");
  if (!out.toString("utf8").includes("中文😀")) fail("bytes-decoded-base64", "ordinary text lost");
}

// ---------------------------------------------------------------------------
// Perf sanity (bounded output + generous wall-clock bound)
// ---------------------------------------------------------------------------
log("== perf ==");
const PERF_BOUND_MS = 8000;
function timed(name, fn) {
  const start = Date.now();
  const out = fn();
  const ms = Date.now() - start;
  log(`ok   perf  ${name} ${ms}ms`);
  if (ms > PERF_BOUND_MS) fail(name, `exceeded ${PERF_BOUND_MS}ms (${ms}ms)`);
  return out;
}
{
  const plain = "ordinary 中文😀 line with no secret\n".repeat(200000); // ~7.4 MiB
  timed("text-8mib-plain", () => loaded[0][1].redactText(plain));
  timed("stream-8mib-plain", () => {
    const r = new loaded[0][1].StreamRedactor([], "utf8");
    let total = 0;
    for (let i = 0; i < plain.length; i += 64 * 1024) total += r.push(Buffer.from(plain.slice(i, i + 64 * 1024))).length;
    total += r.flush().length;
    if (total < plain.length) fail("stream-8mib-plain", "emitted fewer bytes than input");
    return total;
  });
  timed("stream-unclosed-secret-bounded", () => {
    const r = new loaded[0][1].StreamRedactor([], "latin1");
    let emitted = 0;
    r.push(Buffer.from("password="));
    const chunk = Buffer.from("S".repeat(64 * 1024));
    for (let i = 0; i < 64; i++) emitted += r.push(chunk).length; // 4 MiB
    emitted += r.flush().length;
    if (emitted > 4096) fail("stream-unclosed-secret-bounded", `emitted ${emitted} bytes (unbounded)`);
    return emitted;
  });
}

writeFileSync(LOG, "");
appendFileSync(LOG, lines.join("\n") + "\n");
const summary = failures === 0 ? "PARITY OK: pi-extension and server byte-exact across all cases" : `PARITY FAILED: ${failures} case(s)`;
log(summary);
appendFileSync(LOG, summary + "\n");
process.exit(failures === 0 ? 0 : 1);
