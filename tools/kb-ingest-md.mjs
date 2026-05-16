#!/usr/bin/env node
/**
 * Minimal markdown KB ingester for nextclaw.
 *
 * Reads `*.md` files from a directory, splits each by `##` heading,
 * further splits long sections by paragraph, and POSTs each chunk to
 * nextclaw's dashboard `/api/ingest` endpoint with `kind='knowledge'`
 * + anchors that put the chunks under the right doc / topic / scope.
 *
 * This is a CLI proof-of-concept of Phase B++. A proper CLI integration
 * into the `nextclaw` binary, support for PDF/DOCX/CSV, versioning,
 * and a dashboard upload UI come later.
 *
 * Usage:
 *   NEXTCLAW_DASH_TOKEN=... node tools/kb-ingest-md.mjs \
 *     --dir "/path/to/markdown/dir" \
 *     --doc-id ai-course-week1 \
 *     --topic ai-course-setup \
 *     [--scope global | --scope chat:-100123 | --scope user:8064984663] \
 *     [--api http://127.0.0.1:8765]
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, basename, join, extname, relative } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const dir = args.get("dir");
const docId = args.get("doc-id") ?? (dir ? basename(dir) : null);
const topic = args.get("topic");
const scope = args.get("scope") ?? "global";
const apiBase = args.get("api") ?? "http://127.0.0.1:8765";
const agentId = args.get("agent-id") ?? "main";
const version = args.get("version") ?? "v1";
const dashToken = process.env.NEXTCLAW_DASH_TOKEN;

if (!dir || !docId || !dashToken) {
  console.error(
    "usage: NEXTCLAW_DASH_TOKEN=... node kb-ingest-md.mjs --dir <path> --doc-id <id> [--topic X] [--scope global|chat:<id>|user:<id>] [--version v1] [--api http://127.0.0.1:8765]",
  );
  process.exit(2);
}

const anchors = { sender_label: `kb:${docId}` };
{
  const m = /^chat:(.+)$/.exec(scope);
  const u = /^user:(.+)$/.exec(scope);
  if (m) {anchors.chat_id = m[1];}
  if (u) {anchors.sender_id = u[1]; anchors.visibility = "private";}
}

const stats = {
  filesSeen: 0,
  filesProcessed: 0,
  chunksWritten: 0,
  chunksRejected: 0,
  errors: [],
};

/**
 * Split a markdown body into chunks by `##` heading. If a section is
 * longer than `maxChars`, further split by blank-line paragraphs. Each
 * chunk has the form `{ heading, body }` where `heading` is the most
 * recent `##` (or empty for content before the first heading).
 */
function splitMarkdown(body, maxChars = 1500) {
  const lines = body.split("\n");
  /** @type {{heading: string, body: string}[]} */
  const sections = [];
  let currentHeading = "";
  let currentBody = [];
  const flush = () => {
    const text = currentBody.join("\n").trim();
    if (text.length > 0) {sections.push({ heading: currentHeading, body: text });}
    currentBody = [];
  };
  for (const line of lines) {
    // ## or ### are section breaks; # is the doc title, skip
    const m = /^(##{1,2})\s+(.+)$/.exec(line);
    if (m && !line.startsWith("####")) {
      flush();
      currentHeading = m[2].trim();
      continue;
    }
    currentBody.push(line);
  }
  flush();

  // If a section exceeds maxChars, split by blank lines, group up to maxChars.
  /** @type {{heading: string, body: string}[]} */
  const out = [];
  for (const sec of sections) {
    if (sec.body.length <= maxChars) {
      out.push(sec);
      continue;
    }
    const paragraphs = sec.body.split(/\n\n+/);
    let buf = [];
    let bufLen = 0;
    for (const p of paragraphs) {
      if (bufLen + p.length > maxChars && buf.length > 0) {
        out.push({ heading: sec.heading, body: buf.join("\n\n") });
        buf = [p];
        bufLen = p.length;
      } else {
        buf.push(p);
        bufLen += p.length;
      }
    }
    if (buf.length > 0) {out.push({ heading: sec.heading, body: buf.join("\n\n") });}
  }
  // Drop tiny chunks (< 80 chars are likely just headings without content).
  return out.filter((s) => s.body.length >= 80);
}

async function ingestChunk(text, sourceRef, extraAnchors) {
  const body = {
    text,
    source: `kb:${docId}`,
    kind: "knowledge",
    agentId,
    importance: 0.7,
    retentionClass: "pinned",
    anchors: {
      ...anchors,
      ...extraAnchors,
      kb_doc: docId,
      kb_version: version,
      ...(topic ? { topic } : {}),
    },
  };
  body.sourceRef = sourceRef;
  const resp = await fetch(`${apiBase}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-token": dashToken,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const j = await resp.json();
  return j;
}

async function processFile(absPath, baseDir) {
  stats.filesSeen += 1;
  const ext = extname(absPath).toLowerCase();
  if (ext !== ".md") {return;}
  const rel = relative(baseDir, absPath);
  const raw = await readFile(absPath, "utf8");
  const sections = splitMarkdown(raw);
  if (sections.length === 0) {
    console.log(`  [skip] ${rel} — no sections >= 80 chars`);
    return;
  }
  console.log(`  [parse] ${rel} → ${sections.length} sections`);
  let ok = 0;
  let rej = 0;
  for (const [idx, sec] of sections.entries()) {
    const sourceRef = `${rel}:${sec.heading || `section-${idx + 1}`}`;
    // Pre-pend the heading so embedding has a clue what the chunk's topic is
    const text = sec.heading
      ? `${sec.heading}\n\n${sec.body}`
      : sec.body;
    try {
      const result = await ingestChunk(text, sourceRef, {});
      if (result?.outcome?.decision === "accepted") {
        ok += 1;
      } else if (result?.outcome?.decision === "merged") {
        ok += 1;
        // Merged is fine; same chunk already there
      } else {
        rej += 1;
        if (rej <= 2) {
          console.log(`    [reject] ${sec.heading}: ${result?.outcome?.decision}/${result?.outcome?.rejectReason}`);
        }
      }
    } catch (err) {
      rej += 1;
      stats.errors.push(`${rel}:${sec.heading} → ${err.message}`);
    }
  }
  stats.chunksWritten += ok;
  stats.chunksRejected += rej;
  stats.filesProcessed += 1;
  console.log(`         → accepted ${ok}, rejected ${rej}`);
}

async function walk(p, baseDir) {
  const st = await stat(p);
  if (st.isFile()) {
    await processFile(p, baseDir);
    return;
  }
  if (st.isDirectory()) {
    const entries = await readdir(p);
    for (const e of entries) {
      if (e.startsWith(".")) {continue;}
      await walk(join(p, e), baseDir);
    }
  }
}

const startedAt = Date.now();
console.log(`KB ingest:\n  dir=${dir}\n  doc-id=${docId}\n  scope=${scope}\n  topic=${topic ?? "(none)"}\n  version=${version}`);
const baseDir = resolve(dir);
await walk(baseDir, baseDir);
const elapsedMs = Date.now() - startedAt;

console.log("\n=== summary ===");
console.log(`  files seen:        ${stats.filesSeen}`);
console.log(`  files processed:   ${stats.filesProcessed}`);
console.log(`  chunks written:    ${stats.chunksWritten}`);
console.log(`  chunks rejected:   ${stats.chunksRejected}`);
console.log(`  errors:            ${stats.errors.length}`);
if (stats.errors.length > 0 && stats.errors.length <= 10) {
  for (const e of stats.errors) {console.log(`    - ${e}`);}
}
console.log(`  elapsed:           ${(elapsedMs / 1000).toFixed(1)}s`);
