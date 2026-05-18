#!/usr/bin/env node
// nextclaw — npm `prepare` hook.
//
// OpenClaw's plugin installer runs `npm install --omit=dev` against this
// package, which strips devDependencies (including typescript). When that
// happens, we can't compile, so we fall back to the dist/ that's committed
// in-tree. When devDependencies *are* available (a regular checkout for
// development), we rebuild to keep dist/ fresh.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let canBuild = false;
try {
  require.resolve("typescript");
  canBuild = true;
} catch {
  // typescript not installed — likely --omit=dev install path
}

if (!canBuild) {
  console.log("prepare: typescript not installed (likely --omit=dev) — using committed dist/");
  process.exit(0);
}

console.log("prepare: typescript available — running `npm run build`");
const res = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
process.exit(res.status ?? 1);
