#!/usr/bin/env node
// nextclaw — minimal-config helper.
//
// Reads ~/.openclaw/openclaw.json (or creates it), merges the memory-postgres
// plugin slot + entry, then writes it back. Preserves every other key in the
// file (gateway, agents, auth, channels, etc.) so it is safe to run against a
// config produced by `openclaw onboard`.
//
// Required env vars:
//   PG_URL                Postgres connection string
// Optional:
//   NEXTCLAW_CONFIG_PATH  override ~/.openclaw/openclaw.json
//   NEXTCLAW_DASHBOARD    "off" to disable the dashboard block (default: on)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pgUrl = process.env.PG_URL;
if (!pgUrl) {
  console.error("error: PG_URL is required. Example:");
  console.error('  PG_URL="postgres://user:pwd@host:5432/db" node configure-minimal.mjs');
  process.exit(2);
}

const cfgPath =
  process.env.NEXTCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");

fs.mkdirSync(path.dirname(cfgPath), { recursive: true });

let cfg = {};
if (fs.existsSync(cfgPath)) {
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (err) {
    console.error(`error: ${cfgPath} is not valid JSON — refusing to overwrite.`);
    console.error(err.message);
    process.exit(3);
  }
}

cfg.plugins ??= {};
cfg.plugins.slots = { ...(cfg.plugins.slots ?? {}), memory: "memory-postgres" };

const entry = {
  enabled: true,
  config: {
    postgres: { url: pgUrl },
  },
};
if (process.env.NEXTCLAW_DASHBOARD !== "off") {
  entry.config.dashboard = { enabled: true, tokenEnv: "NEXTCLAW_DASH_TOKEN" };
}

cfg.plugins.entries = {
  ...(cfg.plugins.entries ?? {}),
  "memory-postgres": entry,
};

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
console.log(`wrote ${cfgPath}`);
console.log("  plugins.slots.memory             = memory-postgres");
console.log(`  plugins.entries.memory-postgres  = { postgres.url: ${maskUrl(pgUrl)}, dashboard: ${entry.config.dashboard ? "on" : "off"} }`);

function maskUrl(u) {
  return u.replace(/\/\/([^:]+):[^@]+@/, "//$1:***@");
}
