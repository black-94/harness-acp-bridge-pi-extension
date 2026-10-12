---
name: acp-create-template
description: Collect and register a harness-acp-bridge launch template (acp_create_template / create_template). Use when the user wants to create, add, save, or register a reusable ACP launch recipe — choosing harness, local/remote, direct/Docker, permission mode, cwd, command/args/env, or Docker image/mounts/ports/network. Templates are stored information only; this skill never creates a session or starts a harness.
---

# Create an ACP launch template

A launch template is a durable, administrator-owned recipe stored by the **server**. Creating one only
writes the recipe to the server's registry; it **does not create a session and does not start a
harness**.

**Templates are information only.** `acp_create_session` (Pi) / `create_session` (MCP) never takes a
template name, reference, or metadata. A template is something you *read and expand*: later, when a
user wants a session from a template, you `search_template`, read the returned object, drop the
metadata fields that do not belong on a session (`name`, `description`), drop any field that does not
apply to the session you are creating (for example every Docker field when the runtime is `direct`),
collect the values a template cannot supply from the user, and pass the remaining **explicit** fields
to `create_session`.

Templates also **never contain a model**. `model_id`, `thinking_level`, and other per-session
choices stay on `create_session`, so do not ask for them here.

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
2. Keep only the fields `create_session` accepts. **Drop** `name` and `description`, and drop fields
   that do not apply — e.g. every Docker field (`docker_image`, `container_policy`, `login_dirs`,
   `mounts`, `ports`, `host_network`) when the session will be `direct`.
3. Ask the user for what the template cannot supply: `model_id` is **always required**; collect a
   `cwd` when the template has none; collect any explicit overrides (including a `cwd` override).
4. **Omit** a field the template stores as `null` when it is not a valid session value — in
   particular a local template's `remote_host: null` (a session `remote_host` is a non-empty string,
   so pass it only for a remote session) and a `null` `cwd` (supply the user's cwd instead). A
   `null`/`[]`/`false` Docker default (`docker_image`/`container_policy`/`mounts`/`login_dirs`/
   `ports`/`host_network`) is a neutral value and may be passed through for a `direct` session.
5. If the user overrides `runtime` or `target`, re-check the combination: Docker fields require
   `runtime: docker`, a remote target needs `remote_host`, and a local target must not carry one.
6. Call `acp_create_session` / `create_session` with those explicit fields. **Never** pass
   `template`/`name`/`description` (the schema rejects them) — the server neither looks up nor merges
   a template, and the session snapshot records no template identity.

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
- **host_network** — boolean; cannot be combined with published ports.

Skip every Docker question for a `direct` template: the server rejects Docker fields on
`runtime: direct` as `invalid_template`.

## Rules you must hold

- **Ask conditionally.** Do not ask for `remote_host` on a local template, or Docker image/mounts/
  ports/network on a direct template. Do not ask for `model_id` (not part of a template).
- **No secrets.** Never request or echo passwords/tokens/keys.
- **Confirm before writing.** Show the assembled template as a short, readable summary (name,
  harness, target/remote_host, runtime, permission mode, cwd, command/args, env keys — never env
  values you were told are sensitive — and any Docker fields). Get an explicit yes.
- **Do not guess.** If the user cancels, times out, or the UI is unavailable, do not invent an
  answer or register anything. Report what is missing and stop.
- **Never silently overwrite.** On `template_exists`, surface it and ask for another name.
- **Creating a template starts nothing.** Do not create a session, and do not start a harness, as
  part of this workflow.

## Call the tool

Pi:

```json
{ "tool": "acp_create_template",
  "arguments": { "template": { "name": "codebuddy-local", "harness": "codebuddy",
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
  "host_network": false } }
```

### Remote / direct

```json
{ "template": { "name": "codebuddy-remote", "harness": "codebuddy",
  "target": "remote", "remote_host": "user@build-host", "runtime": "direct",
  "cwd": "/workspace/repo" } }
```
