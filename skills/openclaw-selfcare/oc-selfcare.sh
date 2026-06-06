#!/usr/bin/env bash
# oc-selfcare — safe self-upgrade for OpenClaw + the nextclaw (memory-postgres) plugin
# on a SINGLE host.
#
# One box that has `openclaw` and a git-cloned memory plugin (default id:
# memory-postgres) installed. This keeps BOTH current, safely:
#   check openclaw latest → compat preflight (sandbox) → auto-fix the fixable →
#   upgrade openclaw only if preflight passes → update the plugin → verify the
#   gateway + memory came back. It refuses to upgrade onto a broken state and
#   refuses to cross a release flagged as breaking.
#
# Everything is local — no ssh, no multi-host orchestration. Self-contained:
# copy this one file (and the optional config.env) onto any host and run it.
#
# Usage:
#   oc-selfcare.sh check       # read-only: versions + preflight verdict + plugin diff
#   oc-selfcare.sh preflight   # read-only: just the compat verdict
#   oc-selfcare.sh apply       # do it: preflight (+auto-fix) → upgrade → verify
#
# Exit: 0 ok / 1 verify-failed / 2 usage / 10 fix-needed (check mode) / 20 blocked
#
# Config (env or config.env next to this script; all optional):
#   SELFCARE_PLUGIN_ID    plugin id to track            (default: memory-postgres)
#   SELFCARE_CHANNEL      openclaw update channel        (default: stable)
#   SELFCARE_OPENCLAW     path to openclaw binary        (default: autodetect)
#   SELFCARE_PLUGIN_DIR   plugin clone dir               (default: ask openclaw)
#   SELFCARE_TG_CHAT      telegram chat id for reports   (default: none → stdout)
#   SELFCARE_TG_TOKEN     telegram bot token             (default: reuse openclaw's)
#   SELFCARE_SKIP_BREAKING_SCAN=1  skip the gh release-notes breaking scan
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$DIR/config.env" ] && { set -a; . "$DIR/config.env"; set +a; }

MODE="${1:-check}"
case "$MODE" in check|preflight|apply) ;; *) echo "usage: $0 {check|preflight|apply}"; exit 2 ;; esac

PLUGIN_ID="${SELFCARE_PLUGIN_ID:-memory-postgres}"
CHANNEL="${SELFCARE_CHANNEL:-stable}"
OPENCLAW_JSON="${OPENCLAW_JSON:-$HOME/.openclaw/openclaw.json}"

log()  { printf '%s\n' "$*"; }
die()  { printf '%s\n' "$*" >&2; exit "${2:-1}"; }
expand_tilde() { case "$1" in "~"*) printf '%s\n' "${1/#\~/$HOME}" ;; *) printf '%s\n' "$1" ;; esac; }

# ---- locate openclaw ----
OCP="${SELFCARE_OPENCLAW:-$(command -v openclaw 2>/dev/null)}"
[ -n "$OCP" ] && [ -x "$OCP" ] || die "openclaw binary not found (set SELFCARE_OPENCLAW)" 2

# ---- locate plugin clone (ask openclaw, then fall back to common spots) ----
locate_plugin() {
  if [ -n "${SELFCARE_PLUGIN_DIR:-}" ]; then expand_tilde "$SELFCARE_PLUGIN_DIR"; return; fi
  local p
  p="$("$OCP" plugins inspect "$PLUGIN_ID" 2>/dev/null \
        | sed -n 's/^Install path:[[:space:]]*//p; s/^Source path:[[:space:]]*//p' | head -1)"
  if [ -n "$p" ]; then expand_tilde "$p"; return; fi
  for p in "$HOME/.openclaw/plugins/$PLUGIN_ID" "$HOME/.openclaw/extensions/$PLUGIN_ID" \
           "$HOME/nextclaw" "$HOME/$PLUGIN_ID"; do
    [ -d "$p/.git" ] && { printf '%s\n' "$p"; return; }
  done
}
CLONE="$(locate_plugin)"

# ---- versions ----
oc_cur()    { "$OCP" --version 2>/dev/null | sed -n 's/^OpenClaw \([0-9][^ ]*\).*/\1/p' | head -1; }
oc_latest() { npm view openclaw version 2>/dev/null \
              || curl -fsSL https://registry.npmjs.org/openclaw/latest 2>/dev/null | jq -r .version 2>/dev/null; }
plugin_ver() { "$OCP" plugins inspect "$PLUGIN_ID" 2>/dev/null | sed -n 's/^Version:[[:space:]]*//p' | head -1; }
gw_probe()  { "$OCP" gateway status --deep 2>&1 | sed -n 's/^Connectivity probe:[[:space:]]*//p' | head -1; }
gw_ver()    { "$OCP" gateway status --deep 2>&1 | sed -n 's/^Gateway version:[[:space:]]*\([0-9][^ ]*\).*/\1/p' | head -1; }

CUR="$(oc_cur)";  LATEST="$(oc_latest)"
[ -n "$CUR" ]    || die "cannot read current openclaw version — install already broken?" 20
[ -n "$LATEST" ] || die "cannot reach npm registry for latest openclaw version" 20

# =====================================================================
# PREFLIGHT — sandbox compat check. Never touches the live install.
# Echoes a final  PREFLIGHT: <PASS|FIX-NEEDED:reason|FAIL:reason>  line.
# =====================================================================
preflight() {
  log "[selfcare] openclaw current=$CUR target=$LATEST plugin=$PLUGIN_ID clone=${CLONE:-<none>}"

  # current install must be healthy first; don't blame the upgrade for a pre-existing break
  local probe; probe="$(gw_probe)"
  if [ -n "$probe" ] && ! printf '%s' "$probe" | grep -qi ok; then
    log "[selfcare] live gateway probe currently NOT ok ($probe) — refuse to upgrade onto broken state"
    echo "PREFLIGHT: FAIL:probe-current"; return 20
  fi

  if [ -z "$CLONE" ] || [ ! -f "$CLONE/package.json" ]; then
    log "[selfcare] no plugin clone found — nothing memory-side to break"
    echo "PREFLIGHT: PASS"; return 0
  fi

  local SBX; SBX="$(mktemp -d "${TMPDIR:-/tmp}/oc-selfcare.XXXXXX")" || { echo "PREFLIGHT: FAIL:sandbox-install"; return 20; }
  trap 'rm -rf "$SBX"' RETURN
  if ! ( cd "$SBX" && npm init -y >/dev/null 2>&1 \
         && npm install --no-audit --no-fund --silent --prefix "$SBX" "openclaw@$LATEST" semver >"$SBX/i.log" 2>&1 ); then
    log "[selfcare] sandbox install openclaw@$LATEST failed:"; tail -15 "$SBX/i.log" 2>/dev/null
    echo "PREFLIGHT: FAIL:sandbox-install"; return 20
  fi

  semver_ok() { # $1=ver $2=range -> 1/0/?  (empty range = ok)
    node -e "try{const s=require('$SBX/node_modules/semver');const r='$2'.trim();
      console.log(!r?'1':(s.satisfies('$1',r)?'1':'0'))}catch(e){console.log('?')}" 2>/dev/null
  }

  # 1) declared openclaw range on the plugin (peerDependencies/engines/openclawCompat)
  local peer; peer="$(jq -r '.peerDependencies.openclaw // .engines.openclaw // .openclawCompat // ""' "$CLONE/package.json" 2>/dev/null)"
  peer="${peer//null/}"
  if [ -n "$peer" ] && [ "$(semver_ok "$LATEST" "$peer")" = "0" ]; then
    # is there a newer plugin tag whose range DOES cover the target?
    local tag tp newer=""
    ( cd "$CLONE" && git fetch --tags --quiet origin 2>/dev/null || true )
    while IFS= read -r tag; do
      [ -z "$tag" ] && continue
      tp="$(cd "$CLONE" && git show "$tag:package.json" 2>/dev/null | jq -r '.peerDependencies.openclaw // .engines.openclaw // .openclawCompat // ""' 2>/dev/null)"
      tp="${tp//null/}"
      if [ -z "$tp" ] || [ "$(semver_ok "$LATEST" "$tp")" = "1" ]; then newer="$tag"; break; fi
    done < <(cd "$CLONE" && git tag -l 'v*' --sort=-v:refname | head -10)
    if [ -n "$newer" ]; then echo "PREFLIGHT: FIX-NEEDED:plugin-bump:$newer"; return 10; fi
    log "[selfcare] plugin peer '$peer' excludes v$LATEST and no compatible newer tag exists"
    echo "PREFLIGHT: FAIL:peer-mismatch"; return 20
  fi

  # 2) plugin runtime deps resolve? (catches undeclared/missing transitive deps, e.g. undici)
  local miss=""
  if [ -d "$CLONE/node_modules" ]; then
    miss="$(cd "$CLONE" && npm ls --omit=dev --omit=peer --silent 2>&1 \
            | sed -n 's/.*missing: \([^@ ]*\)@.*/\1/p; s/.*UNMET DEPENDENCY \([^ ]*\).*/\1/p' | head -1)"
  fi
  if [ -z "$miss" ]; then
    # whatever the NEW openclaw asks the plugin to provide (its peerDeps) must resolve from the clone
    local p
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      ( cd "$CLONE" && node -e "require.resolve('$p')" 2>/dev/null ) || { miss="$p"; break; }
    done < <(jq -r '.peerDependencies // {} | keys[]?' "$SBX/node_modules/openclaw/package.json" 2>/dev/null)
  fi
  if [ -n "$miss" ]; then echo "PREFLIGHT: FIX-NEEDED:missing-dep:$miss"; return 10; fi

  echo "PREFLIGHT: PASS"; return 0
}

# =====================================================================
# AUTO-FIX — only the two known-safe fixes. Refuses on dirty (dev) clones.
# =====================================================================
plugin_dirty() {
  ( cd "$CLONE" && git status --porcelain --untracked-files=no -- . \
      ':(exclude)package-lock.json' ':(exclude)pnpm-lock.yaml' ':(exclude)yarn.lock' 2>/dev/null | wc -l | tr -d ' ' )
}
revert_lockfiles() { local lf; for lf in package-lock.json pnpm-lock.yaml yarn.lock; do
  [ -f "$CLONE/$lf" ] && ( cd "$CLONE" && git checkout -- "$lf" 2>/dev/null ); done; }

auto_fix() { # $1 = reason  (plugin-bump:<tag> | missing-dep:<pkg>)
  local kind="${1%%:*}" arg="${1#*:}"
  [ -d "$CLONE/.git" ] || die "[selfcare] no clone to fix" 1
  if [ "$(plugin_dirty)" -gt 0 ]; then
    log "[selfcare] clone has uncommitted code changes — refuse auto-fix (protect dev work)"; return 1
  fi
  ( cd "$CLONE" && git config user.email >/dev/null 2>&1 || git config --local user.email selfcare@openclaw
    git config user.name >/dev/null 2>&1 || git config --local user.name selfcare ) 2>/dev/null
  case "$kind" in
    plugin-bump)
      log "[selfcare] auto-fix: checkout plugin $arg"
      ( cd "$CLONE" && git fetch --tags --quiet origin 2>/dev/null || true )
      revert_lockfiles
      ( cd "$CLONE" && git checkout -f "$arg" 2>&1 | tail -2 ) || { log "[selfcare] checkout $arg failed"; return 1; }
      ( cd "$CLONE" && npm install --no-audit --no-fund 2>&1 | tail -3 ) || { log "[selfcare] npm install failed"; return 1; }
      revert_lockfiles ;;
    missing-dep)
      case "$arg" in *[!a-zA-Z0-9_./@-]*|"") log "[selfcare] bad pkg name: $arg"; return 1 ;; esac
      log "[selfcare] auto-fix: npm install $arg (and commit so it survives)"
      ( cd "$CLONE" && npm install --no-audit --no-fund --save "$arg" 2>&1 | tail -3 ) || { log "[selfcare] install $arg failed"; return 1; }
      ( cd "$CLONE" && git add package.json package-lock.json pnpm-lock.yaml yarn.lock 2>/dev/null
        git commit -m "selfcare: add $arg for openclaw compat" 2>&1 | tail -2 || true ) ;;
    *) log "[selfcare] unfixable reason: $1"; return 1 ;;
  esac
  "$OCP" gateway restart 2>&1 | tail -2; sleep 5
}

# =====================================================================
# UPGRADE openclaw core, then verify the live gateway came back on target.
# =====================================================================
upgrade_openclaw() {
  log "[selfcare] upgrading openclaw $CUR → $LATEST (channel $CHANNEL)"
  "$OCP" update --channel "$CHANNEL" --yes --json --timeout 1800 2>&1 | tail -20
  local gv pr
  for _ in 1 2 3 4 5; do
    gv="$(gw_ver)"; pr="$(gw_probe)"
    { [ "$gv" = "$LATEST" ] && printf '%s' "$pr" | grep -qi ok; } && break
    sleep 6
  done
  log "[selfcare] openclaw after: gateway=$gv target=$LATEST probe=$pr"
  [ "$gv" = "$LATEST" ] && printf '%s' "$pr" | grep -qi ok
}

# =====================================================================
# UPDATE the memory plugin to its latest tag, then verify version + memory probe.
# =====================================================================
upgrade_plugin() {
  [ -d "$CLONE/.git" ] || { log "[selfcare] no plugin clone — skip plugin update"; return 0; }
  local cur latest want pv pr
  ( cd "$CLONE" && git fetch --tags --quiet origin 2>/dev/null || true )
  cur="$(cd "$CLONE" && git describe --tags --always 2>/dev/null)"
  latest="$(cd "$CLONE" && git tag -l 'v*' --sort=-v:refname | head -1)"
  [ -z "$latest" ] && { log "[selfcare] plugin: no tags — skip"; return 0; }
  if [ "$(plugin_dirty)" -gt 0 ]; then log "[selfcare] plugin clone DIRTY — skip update (protect dev)"; return 0; fi
  if [ "$cur" = "$latest" ]; then log "[selfcare] plugin already $cur"; return 0; fi
  log "[selfcare] plugin $cur → $latest"
  revert_lockfiles
  ( cd "$CLONE" && git checkout -f "$latest" 2>&1 | tail -2 ) || { log "[selfcare] plugin checkout failed"; return 1; }
  # Full install (NO --omit): the plugin can have transitive runtime deps (e.g. undici)
  # that --omit=dev/--omit=peer would prune, breaking load.
  ( cd "$CLONE" && npm install --no-audit --no-fund 2>&1 | tail -3 ) || { log "[selfcare] plugin npm install failed"; return 1; }
  revert_lockfiles
  "$OCP" gateway restart 2>&1 | tail -2; sleep 8
  want="${latest#v}"
  for _ in 1 2 3; do pv="$(plugin_ver)"; pr="$(gw_probe)"
    { [ "$pv" = "$want" ] && printf '%s' "$pr" | grep -qi ok; } && break; sleep 5; done
  log "[selfcare] plugin after: version=$pv target=$want probe=$pr"
  [ "$pv" = "$want" ] && printf '%s' "$pr" | grep -qi ok
}

# =====================================================================
# Telegram (optional). Reuses openclaw's own bot token if not overridden.
# =====================================================================
notify() {
  local text="$1" tok="${SELFCARE_TG_TOKEN:-}" chat="${SELFCARE_TG_CHAT:-}"
  [ -z "$tok" ] && [ -f "$OPENCLAW_JSON" ] && tok="$(jq -r '.channels.telegram.botToken // empty' "$OPENCLAW_JSON" 2>/dev/null)"
  if [ -n "$tok" ] && [ -n "$chat" ]; then
    curl -fsS -m 25 "https://api.telegram.org/bot${tok}/sendMessage" \
      -d chat_id="$chat" -d parse_mode=HTML --data-urlencode "text=$text" >/dev/null 2>&1 \
      && return 0 || { echo "[selfcare] tg send failed" >&2; return 1; }
  fi
  echo "[selfcare:notify] $text"
}

# =====================================================================
# MAIN
# =====================================================================
case "$MODE" in
  preflight)
    preflight; exit $?
    ;;

  check)
    log "openclaw: current=$CUR latest=$LATEST $([ "$CUR" = "$LATEST" ] && echo '(up-to-date)' || echo '(UPDATE AVAILABLE)')"
    if [ -d "$CLONE/.git" ]; then
      ( cd "$CLONE" && git fetch --tags --quiet origin 2>/dev/null || true )
      pcur="$(cd "$CLONE" && git describe --tags --always 2>/dev/null)"
      plat="$(cd "$CLONE" && git tag -l 'v*' --sort=-v:refname | head -1)"
      log "plugin $PLUGIN_ID: current=$pcur latest=$plat $([ "$pcur" = "$plat" ] && echo '(up-to-date)' || echo '(UPDATE AVAILABLE)') loaded=$(plugin_ver)"
    else
      log "plugin $PLUGIN_ID: clone not found"
    fi
    v="$(preflight)"; rc=$?
    log "$v"
    exit $rc
    ;;

  apply)
    # 1) breaking-release guard (best-effort; needs gh)
    if [ "$CUR" != "$LATEST" ] && [ -z "${SELFCARE_SKIP_BREAKING_SCAN:-}" ] && command -v gh >/dev/null 2>&1; then
      notes="$(gh release view "v$LATEST" --repo openclaw/openclaw 2>/dev/null || gh api "repos/openclaw/openclaw/releases/tags/v$LATEST" 2>/dev/null || true)"
      if printf '%s' "$notes" | grep -qiE 'breaking[ -]?change|migration required|manual (data )?migration|incompatible|drop(ped|s) support'; then
        notify "🛑 $(hostname): OpenClaw v$LATEST release notes look breaking — skipping auto-upgrade, please review manually"
        log "[selfcare] breaking release detected — skipping openclaw upgrade, still refreshing plugin"
        CUR="$LATEST"   # disable core upgrade below; still run plugin update
      fi
    fi

    # 2) preflight (+ one auto-fix retry)
    verdict="$(preflight | awk '/^PREFLIGHT:/{v=$0} END{sub(/^PREFLIGHT:[ \t]*/,"",v);print v}')"
    log "[selfcare] preflight: $verdict"
    case "$verdict" in
      PASS) ;;
      FIX-NEEDED:*)
        if auto_fix "${verdict#FIX-NEEDED:}"; then
          verdict="$(preflight | awk '/^PREFLIGHT:/{v=$0} END{sub(/^PREFLIGHT:[ \t]*/,"",v);print v}')"
          log "[selfcare] post-fix preflight: $verdict"
        fi ;;
    esac
    if [ "$verdict" != "PASS" ]; then
      notify "🛑 $(hostname): openclaw pre-upgrade compat check did not pass ($verdict) — upgrade skipped, memory untouched"
      exit 20
    fi

    # 3) upgrade openclaw core (only if behind)
    oc_line="openclaw $CUR (already latest)"
    if [ "$CUR" != "$LATEST" ]; then
      if upgrade_openclaw; then oc_line="openclaw $CUR→$LATEST ✅"
      else notify "⚠️ $(hostname): openclaw upgrade to v$LATEST failed verify (gateway/probe) — please check"; exit 1; fi
    fi

    # 4) update memory plugin
    if upgrade_plugin; then plug_line="plugin $PLUGIN_ID → $(plugin_ver) ✅"
    else notify "⚠️ $(hostname): memory plugin $PLUGIN_ID failed verify after update — please check"; exit 1; fi

    notify "✅ $(hostname): $oc_line · $plug_line"
    exit 0
    ;;
esac
