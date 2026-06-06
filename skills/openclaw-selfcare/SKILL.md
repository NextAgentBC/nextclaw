---
name: openclaw-selfcare
description: "Safely keep this host's OpenClaw core and the nextclaw (memory-postgres) plugin up to date. Flow: check the latest openclaw release → sandbox compatibility preflight (does the new openclaw still load this plugin and resolve its deps?) → auto-fix what's safely fixable (bump the plugin to a compatible tag, install a missing transitive dep) → upgrade openclaw ONLY if preflight passes → update the plugin → verify the gateway and memory came back. Never upgrades onto an already-broken state; never crosses a release flagged breaking. Use when the user asks: should this host upgrade openclaw / is there a new version / will upgrading break my memory plugin / safely upgrade openclaw / is the memory plugin compatible with the new openclaw / keep nextclaw current. Read-only by default (check); a real upgrade (apply) needs the user to explicitly ask."
metadata:
  version: 1.0.0
  openclaw:
    category: "ops"
    requires:
      bins:
        - bash
        - node
        - npm
        - git
        - jq
        - openclaw
    cliHelp: "bash SKILL_DIR/oc-selfcare.sh check"
---

# openclaw-selfcare — single-host safe upgrade for OpenClaw + nextclaw

OpenClaw ships often. A core upgrade can occasionally land an openclaw whose plugin
API the installed memory plugin doesn't match yet, or one that prunes a transitive
dependency the plugin relies on (a classic: `undici`) — and the memory layer goes
down. This skill **predicts that in a sandbox before touching the live install**,
fixes what's safely fixable, and otherwise **alerts instead of force-upgrading**.

Everything is local to this one host — no ssh, no orchestration. A single
self-contained script, `oc-selfcare.sh`, does the whole job. `SKILL_DIR` below means
this skill's own directory.

## ⚠️ Safety — read-only by default
- `check` / `preflight` = **read-only**, sandbox only, never touches the live install. Run freely.
- `apply` = **mutates production**: really upgrades openclaw, checks out a new plugin tag, restarts the gateway.

**When invoked from chat: default to `check`.** Only run `apply` when the user
explicitly asks to upgrade ("upgrade / apply / take it up to latest"). Don't apply on
your own — the memory plugin is backed by the user's Postgres memory store; caution wins.

## When to use
User asks (any language): should this host upgrade / is there a new openclaw / is it
safe to upgrade / will it break my memory plugin / is the plugin compatible with the
new version / keep nextclaw current / safe upgrade.

## Usage

### 1. check — read-only overview (most common)
```bash
bash SKILL_DIR/oc-selfcare.sh check
```
Prints:
- `openclaw: current=… latest=… (up-to-date | UPDATE AVAILABLE)`
- `plugin memory-postgres: current=… latest=… (…) loaded=…`
- a final `PREFLIGHT: <verdict>` line (table below)

### 2. preflight — just the compatibility verdict
```bash
bash SKILL_DIR/oc-selfcare.sh preflight
```

### 3. apply — the real upgrade (needs explicit user go-ahead)
```bash
bash SKILL_DIR/oc-selfcare.sh apply
```
Order: breaking-release scan → preflight (+ one auto-fix retry) → upgrade openclaw
only if compatible → update the plugin → verify gateway version + memory probe. Any
failed verify exits non-zero and alerts; memory is never left half-upgraded.

## Reading the preflight verdict
| verdict | meaning | who handles it |
|---|---|---|
| `PASS` | compatible, safe to upgrade | apply proceeds |
| `FIX-NEEDED:plugin-bump:<tag>` | a newer plugin tag is needed to match the new openclaw | apply auto-fixes |
| `FIX-NEEDED:missing-dep:<pkg>` | plugin is missing a runtime dep (e.g. undici) | apply runs `npm install` |
| `FAIL:peer-mismatch` | plugin declares incompatibility and no newer tag exists | **not auto-fixable** — wait for an upstream plugin release |
| `FAIL:probe-current` | the install was **already unhealthy before** upgrading | **don't upgrade** — investigate the current state first |
| `FAIL:sandbox-install` | couldn't fetch the target openclaw (network/registry) | retry / check connectivity |

## How to report back
Concise. Lead with the headline:
- `✅ openclaw and memory plugin both current`, or
- `⚠️ update available / preflight did not pass (reason)`.
Quote the version numbers that matter; don't dump raw tables unless asked.

## Deeper manual health check
For a full memory-backend check (Postgres reachable, `vector`/`pg_trgm`/`btree_gin`
extensions present, embedding endpoint live, plugin tools registered), run OpenClaw's
own doctor:
```bash
openclaw doctor
```
A healthy plugin shows `memory-postgres: capability + tools registered (...)`.

## Install on a new host (operator SOP — not something the agent runs unprompted)
Prereq: this host already has openclaw + the nextclaw plugin (git clone, enabled).
```bash
# 1. install the skill from the plugin clone (or from ClawHub / git)
openclaw skills install <nextclaw-clone>/skills/openclaw-selfcare --force

# 2. self-check (read-only)
bash ~/.openclaw/workspace/skills/openclaw-selfcare/oc-selfcare.sh check

# 3. (optional) daily automatic safe upgrade at 06:00 local time
( crontab -l 2>/dev/null | grep -v oc-selfcare.sh
  echo "CRON_TZ=$(cat /etc/timezone 2>/dev/null || echo UTC)"
  echo "0 6 * * * bash \$HOME/.openclaw/workspace/skills/openclaw-selfcare/oc-selfcare.sh apply >> /tmp/oc-selfcare.log 2>&1"
) | crontab -

# 4. (optional) Telegram reports: cp config.env.example config.env, set SELFCARE_TG_CHAT
#    (bot token defaults to reusing openclaw's own channels.telegram.botToken)
```

## Configuration (all optional — see config.env.example)
`SELFCARE_PLUGIN_ID` (default memory-postgres) · `SELFCARE_CHANNEL` (stable) ·
`SELFCARE_PLUGIN_DIR` (default: ask openclaw) · `SELFCARE_TG_CHAT` / `SELFCARE_TG_TOKEN` ·
`SELFCARE_SKIP_BREAKING_SCAN`.

## Built-in safety guarantees (why this is a "safe" upgrade)
- Won't upgrade unless a sandbox compatibility preflight passes.
- Breaking release notes (regex on `breaking | migration required | incompatible | dropped support`)
  → skip the core upgrade, alert only.
- If the live gateway probe is already not ok before upgrading (`FAIL:probe-current`),
  refuse to stack an upgrade on a broken state.
- Plugin tag switch uses `git checkout -f` + per-file lockfile revert (avoids the
  multi-pathspec "revert silently failed → checkout aborted" trap).
- Plugin deps installed with a **full** `npm install` (no `--omit`, or transitive deps
  like undici get pruned and the plugin fails to load).
- A plugin clone with uncommitted code changes (a dev box) is **skipped** by both
  auto-fix and the plugin update — never bulldozed.
- After upgrading, it retries verification that the gateway version == target and the
  memory probe == ok, else exits non-zero and alerts.
