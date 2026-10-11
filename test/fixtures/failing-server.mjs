/**
 * Test fixture: a "server module" that emits credential-bearing diagnostics to stdout/stderr and
 * then fails to load. Used to prove the detached bootstrap's redacting sink masks everything —
 * dynamic-import diagnostics, the failed-startup stack — while keeping useful ordinary text.
 *
 * It writes credentials split across arbitrary chunk boundaries on purpose. Never a real secret:
 * the literal comes from FAKE_API_KEY and is fake.
 */
const secret = process.env.FAKE_API_KEY || "missing-fake-key-value";

process.stdout.write("stdout ordinary 中文😀 ok\n");
// Provider-shaped token arriving in two writes (split mid-token).
process.stdout.write("Authorization: Bearer sk-ant-");
process.stdout.write("FAKEPROVIDERTOKEN0123456789abcdef\n");
process.stderr.write("token=" + secret + "\n");
// Known env literal split into arbitrary pieces.
process.stderr.write("echoed key: " + secret.slice(0, 5));
process.stderr.write(secret.slice(5) + " end\n");
// Multi-line PEM private key split across writes.
process.stderr.write("-----BEGIN RSA PRIVATE KEY-----\nMIIf");
process.stderr.write("akebodyline-one\nMIIfakebodyline-two\n");
process.stderr.write("-----END RSA PRIVATE KEY-----\n");

throw new Error(`IMPORT_ERROR failed to load module: credential=${secret} | ordinary diagnostic: could not read /tmp/never/config.yaml`);
