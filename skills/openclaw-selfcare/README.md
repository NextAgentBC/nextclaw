# openclaw-selfcare

A small OpenClaw **ops skill** that keeps one host's OpenClaw core and the nextclaw
(`memory-postgres`) plugin up to date — *safely*.

OpenClaw releases frequently. A core upgrade can occasionally ship an openclaw whose
plugin API this memory plugin doesn't match yet, or one that prunes a transitive
dependency the plugin needs (e.g. `undici`). Either way, the memory layer can go down
mid-upgrade. This skill predicts that **in a sandbox before touching the live install**,
auto-fixes the safely-fixable cases, and otherwise alerts instead of force-upgrading.

## What it does

```
check latest openclaw
   → sandbox preflight: does the new openclaw still load this plugin + resolve its deps?
      → PASS         : upgrade openclaw, then update the plugin, then verify
      → FIX-NEEDED   : bump plugin to a compatible tag / install the missing dep, re-check
      → FAIL         : skip the upgrade, alert (never upgrade onto a broken/incompatible state)
```

## Quick start

```bash
# read-only status + compatibility verdict
bash oc-selfcare.sh check

# the real upgrade (preflight → upgrade → verify)
bash oc-selfcare.sh apply
```

Install it as an OpenClaw skill so the agent can answer "is it safe to upgrade?":

```bash
openclaw skills install ./skills/openclaw-selfcare --force
```

See [`SKILL.md`](./SKILL.md) for the full command reference, the preflight verdict
table, the new-host SOP (incl. an optional daily cron), and the built-in safety
guarantees. Configuration is optional — see [`config.env.example`](./config.env.example).

## Requirements

`bash`, `node`, `npm`, `git`, `jq`, and `openclaw` on PATH. The plugin clone is located
automatically via `openclaw plugins inspect memory-postgres`.

## Safety

- Read-only `check` / `preflight` never touch the live install.
- `apply` refuses to upgrade unless the sandbox preflight passes, refuses to cross a
  release flagged breaking, and refuses to stack an upgrade on an already-unhealthy
  install.
- A plugin clone with uncommitted changes (a dev box) is skipped, never bulldozed.
- After upgrading it verifies the gateway version and memory probe actually recovered.

Licensed under Apache-2.0, same as the rest of nextclaw.
