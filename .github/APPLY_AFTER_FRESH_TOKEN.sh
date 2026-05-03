#!/bin/bash
# One-shot post-push setup: apply repo description, topics, homepage, and create v0.1.0 release.
# Requires: NEXTCLAW_PUSH_TOKEN env var with `Contents:Write + Metadata:Read+Write` on this repo.
#
#   export NEXTCLAW_PUSH_TOKEN='github_pat_...'
#   bash .github/APPLY_AFTER_FRESH_TOKEN.sh
#
# After success: revoke the token.

set -euo pipefail
: "${NEXTCLAW_PUSH_TOKEN:?NEXTCLAW_PUSH_TOKEN env var required}"

REPO="NextAgentBC/nextclaw"
API="https://api.github.com/repos/$REPO"

echo "→ Setting description, homepage, topics..."
curl -sS -X PATCH "$API" \
  -H "Authorization: Bearer $NEXTCLAW_PUSH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{
    "description": "Postgres + pgvector long-term memory plugin for OpenClaw. 4-tier recall, multi-key Xinhua-dictionary indexing, deterministic-first ingest, hard per-agent isolation, real-time dashboard.",
    "homepage": "https://nextagent.ca",
    "has_issues": true,
    "has_discussions": true,
    "has_wiki": false
  }' | jq -r '.full_name + " · " + .description'

echo "→ Setting topics..."
curl -sS -X PUT "$API/topics" \
  -H "Authorization: Bearer $NEXTCLAW_PUSH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"names":["openclaw","memory","postgres","pgvector","long-term-memory","vector-search","hnsw","rag","ai-agent","multi-agent","discord-bot","self-hosted"]}' \
  | jq -r '"topics: " + (.names | join(", "))'

echo "→ Creating v0.1.0 release..."
BODY=$(jq -Rsa . < .github/RELEASE_NOTES_v0.1.0.md)
curl -sS -X POST "$API/releases" \
  -H "Authorization: Bearer $NEXTCLAW_PUSH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d "{
    \"tag_name\": \"v0.1.0\",
    \"name\": \"v0.1.0 — initial public release\",
    \"body\": $BODY,
    \"draft\": false,
    \"prerelease\": false,
    \"target_commitish\": \"main\"
  }" | jq -r '"release: " + .html_url'

echo
echo "✅ All metadata applied. Revoke the token now."
