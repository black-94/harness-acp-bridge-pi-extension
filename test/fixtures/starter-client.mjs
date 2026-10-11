/**
 * Starter-client helper: runs the *real* `ServerLifecycle.ensure()` in a separate Node process
 * (loading the TypeScript source via Node's type transformer), prints the result, and exits.
 * Used to prove that a server started by a client that has fully exited survives and keeps its
 * logging sanitized.
 */
const mod = await import(process.env.HARNESS_STARTER_LIFECYCLE);
const settings = JSON.parse(process.env.HARNESS_STARTER_SETTINGS);
const lifecycle = new mod.ServerLifecycle(settings, process.env, process.cwd());
const result = await lifecycle.ensure();
process.stdout.write(JSON.stringify(result));
