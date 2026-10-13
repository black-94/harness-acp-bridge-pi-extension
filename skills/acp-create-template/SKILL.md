---
name: acp-create-template
description: Collect and register a harness-acp-bridge launch template (acp_create_template / create_template). Use when the user wants to create, add, save, or register a reusable ACP launch recipe — choosing model/thinking defaults, natural-language before/after-start actions and special instructions, harness, local/remote, direct/Docker, permission mode, cwd, command/args/env, or Docker networking (none, host, or generic proxy) and other Docker settings. Templates are stored information only; this skill never creates a session or starts a harness.
---

# Create an ACP launch template

A launch template is a durable, administrator-owned recipe stored by the **server**. Creating one only
writes the recipe to the server's registry; it **does not create a session and does not start a
harness**.

**Templates are information only.** `acp_create_session` (Pi) / `create_session` (MCP) never takes a
template name, reference, or metadata. A template is something you *read and expand*: later, when a
user wants a session from a template, you `search_template`, read the returned object, drop the
template-only fields that do not belong on a session, drop any field that does not apply (for
example every Docker field when the runtime is `direct`), collect missing values from the user,
and pass only **explicit** allowed fields to `create_session`.

Templates may hold optional `model` and `thinking` defaults, mapped by the calling LLM to session
`model_id` and `thinking_level`. No candidate models or thinking levels need to be hardcoded in
server YAML; the live harness validates requested values. Omitted/null defaults mean ask for a
missing model when starting a session and omit an unspecified thinking level.

`before_start`, `after_start`, and `special_instructions` are optional natural-language text
(or null), not shell/argv hook definitions. The **calling LLM**, not the bridge server or client,
executes the actions with its available tools at the appropriate stage. Registration only stores
these instructions; do not execute them while creating a template.

## How the pieces fit

- Pi: the tools are `acp_search_template` and `acp_create_template`.
- MCP: the bare tools are `search_template` and `create_template`.
- `create_template` / `acp_create_template` are client aliases for the server's
  `register_template` operation; they call `POST /api/register_template`. There is no
  `create_template` HTTP endpoint, and no delete tool is exposed.
- This skill is a portable [Agent Skills](https://agentskills.io/specification) directory. An MCP
  host loads it the same way: point its skill loader at this package's `skills/` directory (or copy
  the whole `skills/acp-create-template/` directory) — `SKILL.md` is plain Markdown, so an MCP-only
  host needs no Pi runtime, and the `create_template` tool is the executable counterpart.

Use `search_template`/`acp_search_template` with `name` (exact) or `query`/`harness` before
registering, so you can warn about an existing name.

## Using a template later (information only — no session reference)

When a user later wants to start a session from a saved template, read and **expand** it — never
reference it:

1. `acp_search_template` / `search_template` (exact `name` when known, else `query`/`harness`) and
   read the returned object in full. Never guess a template's contents; if several match, ask which.
2. Read `special_instructions` as guidance throughout the workflow, subject to user approval and
   safety rules. Map non-null `model` → `model_id` and `thinking` → `thinking_level`; explicit user
   overrides win. For Docker, map `network_mode` to session `host_network`: `host` → true,
   `none`/`proxy` → false. For `proxy`, pass the **returned env**: the server generates identical
   lowercase `http_proxy`/`https_proxy` from `proxy_port` and a common-private-range `no_proxy`.
   Keep all three and unrelated env entries. **Drop** `name`, `description`, `model`,
   `thinking`, `network_mode`, `proxy_port`, `before_start`, `after_start`, `special_instructions`, and fields
   that do not apply — e.g. all Docker fields for `direct`. Templates no longer accept `host_network`.
3. Ask only for what the template cannot supply: a missing `model_id` or `cwd`, and any explicit
   overrides. Never infer model candidates or thinking levels from a static server YAML list.
4. **Omit** a field the template stores as `null` when it is not a valid session value — in
   particular a local template's `remote_host: null` (a session `remote_host` is a non-empty string,
   so pass it only for a remote session) and a `null` `cwd` (supply the user's cwd instead). A
   `null`/`[]`/`false` Docker default (`docker_image`/`container_policy`/`mounts`/`login_dirs`/
   `ports`/`host_network`) is a neutral value and may be passed through for a `direct` session.
5. If the user overrides `runtime` or `target`, re-check the combination: Docker fields require
   `runtime: docker`, a remote target needs `remote_host`, and a local target must not carry one.
   For Docker, preserve the saved `network_mode: none | host | proxy` choice (see below). Proxy
   mode is generic, not tied to Xray, and uses bridge networking plus environment variables.
   Verify the address/protocol from the execution host/container, not from the bridge client's
   machine; never silently change network mode.
6. Execute `before_start` actions yourself with available tools **before** calling
   `acp_create_session` / `create_session`. Ask for approval where needed. On failure or unavailable
   tools, stop and report the blocker; never claim an action ran when it did not.
7. Create the session with only allowed explicit fields; **never** pass `template` or any
   template-only fields from step 2. The server neither looks up nor merges a template, and the
   session snapshot records no template identity.
8. Complete any required authentication, then execute `after_start` actions yourself after
   successful startup before sending normal work. Do not run them on a failed/unready session.
   Continue following `special_instructions`, without overriding the user's intent or safety rules.

## Interview the user, then confirm

Ask only the questions that apply (see the branching below). Do **not** ask for anything the
template cannot hold. Never ask for or accept passwords, tokens, API keys, or other secrets.

Collect, in a sensible order:

1. **name** (required) — a unique identifier: letters, digits, `_`, `-`, 1–128 chars. Search first;
   if the name exists, say so — registration returns `template_exists` and **never overwrites** —
   and ask for a different name (or delete-then-register is not available here, so choose a new one).
2. **description** (optional) — a short human-readable note about what the template is for. It is
   searchable (`search_template` matches it) and shown to the user later, so prefer a useful line
   when one is available; skip it rather than inventing one.
3. **harness** (required) — `codebuddy`, `codex`, or `agy`.
   - **model / thinking** (optional) — default model ID and thinking level as nonblank strings, or
     null/omitted. Accept the user's values; do not invent or restrict them to static candidates.
   - **before_start / after_start / special_instructions** (optional) — natural-language text for
     the calling LLM to execute before startup, after startup, and follow throughout. Ask what
     actions/guidance the user wants; store their text without executing or converting it to hooks.
4. **Where it runs** — `local` (default) or `remote`.
   - If `remote`: ask for **remote_host** (an SSH alias or `user@host`). Required for remote.
   - If `local`: omit `remote_host` entirely (a local template must not carry one).
5. **runtime** — `direct` (default) or `docker`.
   - If `direct`: skip every Docker question below.
   - If `docker`: ask for **docker_image** (required for a new container). Optionally
     **container_policy** (`remove` default, or `keep`).
6. **permission_mode** — `read`, `edit`, `auto` (default), or `yolo`. Mention that `yolo` disables
   approval prompts; never preselect it for the user.
7. **cwd** (optional) — the working directory; when given it must be an absolute path (the path
   *inside the container* for Docker). If omitted, the caller must pass `cwd` on `create_session`.
8. **command / args** (optional) — override the executable only when the user needs a specific
   binary. `command` is an absolute executable path or a single executable name; empty/omitted uses
   the harness's built-in command from the execution target's PATH. `args` is a list of extra argv
   entries.
9. **env** (optional) — environment variables as a plain string map.
   - **Warn the user**: template `env` values are stored in the server's private registry file and
     are not a secret store. Do not put credentials, tokens, or keys in `env`; prefer the harness's
     existing login. (When a template's `env` is later expanded into a session's `env`, that session
     journals redact the secret values — but this registry keeps them unchanged.)

Only if runtime is `docker`, also collect the Docker fields:

- **login_dirs** and **mounts** — bind mounts as `{source, target, read_only?}`. `source` is an
  absolute path on the **execution host** (the remote host when `target` is `remote`); `target` is
  an absolute path **inside the container**. `login_dirs` are meant for persisting the harness's own
  login/credentials, not bridge credentials. `target` values must be unique.
- **ports** — published ports as `{host_port, container_port, protocol? (tcp/udp), host_ip?}`.
- **network_mode — exactly one choice**: `none`, `host`, or `proxy` (default `none`). Ask as a
  single-choice question, not independent host-network/proxy booleans. No legacy template
  `host_network` is accepted; only session parameters use that boolean.
  - **none**: ordinary Docker bridge networking; no active proxy values in `env`.
  - **host**: host networking; no active proxy values and no published `ports`.
  - **proxy**: ordinary Docker bridge networking plus a **generic HTTP proxy service**, not
    necessarily Xray. Ask only for **proxy_port** (integer 1–65535) on the Docker execution host.
    Do **not** ask for separate HTTP/HTTPS proxy URLs, proxy hostname, or bypass list. The server
    generates both lowercase `env.http_proxy` and `env.https_proxy` as the **same**
    `http://host.docker.internal:PORT` URL, and `env.no_proxy` as
    `localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local,.internal`.
    It replaces stale lowercase/uppercase proxy variables (including ALL_PROXY) while preserving
    unrelated env values. HTTP CONNECT handles HTTPS destinations; no separate HTTPS port is needed.
  `proxy_port` must be omitted/null for `none`/`host`, and required for `proxy`. Remove/clear stale
  proxy values when switching to `none`/`host`; active HTTP(S)/ALL proxy values conflict with those
  modes. `no_proxy` alone does not enable a proxy. Inspect image/container proxy settings when needed
  so inherited settings do not defeat the choice. A reused container already fixes its network mode;
  inspect it rather than attempting to override it. Do not ask Docker network questions for `direct`.

### Proxy reachability and safety

- The proxy may be Xray or **any HTTP-compatible proxy endpoint**. Confirm that the harness HTTP
  client supports the generated proxy environment variables and CIDR entries in `no_proxy`; the
  bridge passes these settings through but does not implement the HTTP client's bypass behavior.
- Configure the harness container's environment, not bridge/client settings or Docker daemon/image
  pulls. For a same-host service, “host” means the Docker execution host (the remote host for
  `target: remote`), not the Pi/MCP client or local bridge server.
- `host.docker.internal` is the **fixed host address** for proxy mode. Verify it resolves and
  reaches the proxy port from the execution host's container network. In bridge mode, localhost
  refers to the container, not its host. Linux setups may need host-gateway configuration; do not
  assume DNS or a loopback-only listener is reachable, and do not change Docker/network settings
  without approval.
- Confirm the actual port serves an **HTTP proxy**, not just any listening service or a SOCKS-only
  endpoint. Do not guess conventional ports or silently replace the generated address/protocol.
- Report routing/listener/firewall blockers and ask before changing infrastructure or network mode.
  Never automatically expose a proxy on `0.0.0.0` or publish/forward its port.
- Registration starts nothing. Put requested checks in `before_start` / `after_start` for the
  calling LLM to execute later. Verify connectivity from the container before normal work; storing
  or forwarding env does not prove that traffic actually uses a working proxy.

Skip every Docker question for a `direct` template: the server rejects Docker fields on
`runtime: direct` as `invalid_template`.

## Rules you must hold

- **Ask conditionally.** Do not ask for `remote_host` on a local template, or Docker image/mounts/
  ports/network on a direct template. Use `model`/`thinking` for template defaults, not session
  field names `model_id`/`thinking_level`.
- **No secrets.** Never request or echo passwords/tokens/keys.
- **Confirm before writing.** Show the assembled template as a short, readable summary (name,
  harness, model/thinking, before_start/after_start/special_instructions, target/remote_host,
  runtime, permission mode, cwd, command/args, env keys — never env
  values you were told are sensitive — and any Docker fields, including the single network choice
  and proxy_port plus the generated proxy URL and common-private bypass list when `proxy` is chosen). Get an explicit yes.
- **Do not guess.** If the user cancels, times out, or the UI is unavailable, do not invent an
  answer or register anything. Report what is missing and stop.
- **Never silently overwrite.** On `template_exists`, surface it and ask for another name.
- **Creating a template starts nothing.** Do not create a session, and do not start a harness, as
  part of this workflow. Do not execute before_start/after_start instructions during registration.

## Call the tool

Pi:

```json
{ "tool": "acp_create_template",
  "arguments": { "template": { "name": "codebuddy-local", "harness": "codebuddy",
    "model": "user-selected-model", "thinking": "user-selected-level",
    "before_start": "Check the working directory and dependencies before startup.",
    "after_start": "Check that the session is ready before sending work.",
    "special_instructions": "Ask before changing permissions.",
    "target": "local", "runtime": "direct", "permission_mode": "auto", "cwd": "/workspace/repo" } } }
```

MCP: the same object as `arguments` for `create_template` (the parameter is `{ "template": { ... } }`).

On success the server returns the stored template with defaults applied. On failure it keeps a
useful code — `invalid_template` (400), `template_exists` (409), or `invalid_param` (400) — report
it verbatim and correct the input.

## Examples

### Local / direct (uses the harness's existing PATH login)

```json
{ "template": { "name": "codebuddy-local", "harness": "codebuddy",
  "target": "local", "runtime": "direct", "permission_mode": "auto",
  "cwd": "/workspace/repo" } }
```

### Docker (replace the image and host paths before registering)

```json
{ "template": { "name": "codebuddy-docker", "harness": "codebuddy",
  "target": "local", "runtime": "docker", "docker_image": "registry.example.com/codebuddy:latest",
  "container_policy": "remove", "cwd": "/workspace/repo",
  "login_dirs": [ { "source": "/home/me/.codebuddy", "target": "/home/me/.codebuddy" } ],
  "mounts": [ { "source": "/host/repo", "target": "/workspace/repo", "read_only": false } ],
  "ports": [ { "host_port": 8080, "container_port": 8080, "protocol": "tcp" } ],
  "network_mode": "none" } }
```

### Docker / generic proxy (example address and port — replace after verification)

`8080` below is illustrative, **not** a detected/default proxy port. The hostname must be available
and reachable from the execution host's container network. Confirm both with the user before saving.

```json
{ "template": { "name": "codex-docker-proxy", "harness": "codex",
  "target": "local", "runtime": "docker", "docker_image": "your-codex-image:latest",
  "cwd": "/workspace/repo", "network_mode": "proxy", "proxy_port": 8080,
  "env": {},
  "before_start": "Verify host.docker.internal and the confirmed HTTP proxy port are reachable from the Docker execution host's container network; do not change listener/firewall settings without approval.",
  "after_start": "Check proxy connectivity from the harness container before sending normal work; report failures without changing network mode." } }
```

### Remote / direct

```json
{ "template": { "name": "codebuddy-remote", "harness": "codebuddy",
  "target": "remote", "remote_host": "user@build-host", "runtime": "direct",
  "cwd": "/workspace/repo" } }
```
