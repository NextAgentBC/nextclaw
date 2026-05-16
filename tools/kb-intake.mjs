#!/usr/bin/env node
/**
 * Unified KB intake — applies the folder taxonomy + audit + ingest
 * pipeline for a single uploaded file.
 *
 * This is the ONLY tool that decides where uploaded content goes.
 * Telegram bot, manual scp, dashboard upload UI, future channels —
 * all call this with the same metadata schema, and the taxonomy is
 * enforced mechanically (see docs/KB_TAXONOMY.md).
 *
 * Usage:
 *   NEXTCLAW_DASH_TOKEN=... node tools/kb-intake.mjs \
 *     --file <path-to-file> \
 *     --sender-user-id <telegram user id, or "teacher" for owner-via-scp> \
 *     [--chat-id <telegram chat id; omit for DM>] \
 *     [--chat-type private|group|supergroup] \
 *     [--caption "the message caption, supports #hashtag hints"] \
 *     [--owner-id <telegram user id of the bot owner>] \
 *     [--course-id ai-course]    # explicit override
 *     [--topic week1]            # explicit override
 *     [--doc-id week3-homework]  # explicit override (stable across versions)
 *     [--kb-root /home/ubuntu/.openclaw/kb] \
 *     [--api http://127.0.0.1:8765] \
 *     [--no-ingest]              # save file but skip nextclaw ingest
 *     [--dry-run]                # show planned action, don't touch fs
 */

import { readFile, mkdir, copyFile, appendFile, stat, readdir } from "node:fs/promises";
import { resolve, basename, extname, join, dirname, relative } from "node:path";

/* ----------------------------------- args ---------------------------------- */
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith("--")) {continue;}
  const k = a.slice(2);
  const nxt = process.argv[i + 1];
  if (nxt === undefined || nxt.startsWith("--")) {
    args.set(k, "true");
  } else {
    args.set(k, nxt); i += 1;
  }
}

const filePath = args.get("file");
const senderUserId = args.get("sender-user-id");
const ownerId = args.get("owner-id") ?? "8064984663"; // Yao by default for this deployment
const chatId = args.get("chat-id");
const chatType = args.get("chat-type") ?? (chatId ? "supergroup" : "private");
const caption = args.get("caption") ?? "";
const overrideCourseId = args.get("course-id");
const overrideTopic = args.get("topic");
const overrideDocId = args.get("doc-id");
const kbRoot = args.get("kb-root") ?? process.env.OPENCLAW_KB_ROOT ?? "/home/ubuntu/.openclaw/kb";
const apiBase = args.get("api") ?? "http://127.0.0.1:8765";
const noIngest = args.get("no-ingest") === "true";
const dryRun = args.get("dry-run") === "true";
const dashToken = process.env.NEXTCLAW_DASH_TOKEN;

if (!filePath || !senderUserId) {
  console.error("usage: --file <path> --sender-user-id <id> [--chat-id <id>] [--caption ...]");
  process.exit(2);
}
if (!dashToken && !noIngest && !dryRun) {
  console.error("NEXTCLAW_DASH_TOKEN env required when ingesting. Pass --no-ingest to skip.");
  process.exit(2);
}

/* -------------------------- caption hashtag parser ------------------------- */
function parseCaption(s) {
  const hints = {};
  const tags = s.match(/#[\w-]+/g) ?? [];
  for (const t of tags) {
    if (t === "#share") {hints.share = true;}
    if (t === "#teacher-only") {hints.teacherOnly = true;}
    if (t === "#homework") {hints.homework = true;}
    // #week3 / #weekN attached form
    const week = /#week(\d+)/i.exec(t);
    if (week) {hints.week = `week${week[1]}`;}
  }
  // Inline key value style: `#topic fractions`, `#course ai-course`, `#week 1`, `#doc-id X`, `#version 2`
  const kvPairs = s.match(/#(?:topic|course|doc-id|docid|version|week)\s+\S+/gi) ?? [];
  for (const kv of kvPairs) {
    const m = /#(\w[\w-]*)\s+(\S+)/.exec(kv);
    if (!m) {continue;}
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === "week") {hints.week = `week${val.replace(/\D/g, "") || val}`;}
    else if (key === "docid") {hints["doc-id"] = val;}
    else {hints[key] = val;}
  }
  return hints;
}

/* ------------------------- chat-id path normaliser ------------------------- */
// Telegram chat ids for groups/supergroups are negative; the folder name
// strips the leading "-" so we don't end up with `tg--1001234567890`.
function tgPath(id) {
  return `tg-${String(id).replace(/^-/, "")}`;
}

/* -------------------------------- slugifier -------------------------------- */
function slug(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9一-鿿\-.]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/* -------------------------- routing decision tree -------------------------- */
function decideTargetSubpath({ senderUserId, ownerId, chatId, chatType, hints }) {
  const isOwner = senderUserId === ownerId || senderUserId === "teacher";
  const isDM = chatType === "private" || !chatId;

  // Caption-level overrides win first
  if (hints.course) {
    return { dir: ["courses", slug(hints.course), hints.week || hints.topic || "uploaded"], visibility: "public", scope: "global" };
  }

  if (isDM) {
    if (isOwner) {
      // Teacher in DM — staging area unless explicitly tagged
      if (hints.topic || hints.week) {
        return {
          dir: ["courses", slug(overrideCourseId || "default"), slug(hints.week || hints.topic || "misc")],
          visibility: "public",
          scope: "global",
        };
      }
      return { dir: ["inbox", isoDate()], visibility: "public", scope: "global" };
    }
    // Student in DM
    if (hints.share) {
      return { dir: ["students", `tg-${senderUserId}`, "shared-with-teacher"], visibility: "private", scope: "user" };
    }
    return {
      dir: ["students", `tg-${senderUserId}`, hints.homework ? "homework" : "inbox"],
      visibility: "private",
      scope: "user",
    };
  }

  // Group / supergroup
  if (isOwner) {
    if (hints.teacherOnly) {
      return { dir: ["groups", tgPath(chatId), "teacher-only"], visibility: "private", scope: "chat" };
    }
    return { dir: ["groups", tgPath(chatId), "shared"], visibility: "public", scope: "chat" };
  }
  // Student in group
  if (hints.share) {
    return { dir: ["groups", tgPath(chatId), "shared"], visibility: "public", scope: "chat" };
  }
  // Default: treat as personal homework even in group
  return {
    dir: ["students", `tg-${senderUserId}`, hints.homework ? "homework" : "inbox"],
    visibility: "private",
    scope: "user",
  };
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function nextVersion(targetDir, docId) {
  if (!(await pathExists(targetDir))) {return 1;}
  const entries = await readdir(targetDir);
  const versions = entries
    .map((e) => {
      const m = new RegExp(`__${docId}__v(\\d+)\\.[^.]+$`).exec(e);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter((v) => v > 0);
  return Math.max(0, ...versions) + 1;
}

/* ----------------------------------- main ---------------------------------- */
async function main() {
  const absSrc = resolve(filePath);
  if (!(await pathExists(absSrc))) {
    console.error(`file not found: ${absSrc}`);
    process.exit(3);
  }
  const origName = basename(absSrc);
  const ext = extname(origName).toLowerCase();
  const baseSlug = slug(origName.replace(ext, ""));
  const docId = overrideDocId ? slug(overrideDocId) : baseSlug;
  const hints = parseCaption(caption);

  const decision = decideTargetSubpath({ senderUserId, ownerId, chatId, chatType, hints });
  const targetDir = resolve(kbRoot, ...decision.dir);
  const version = parseInt(hints.version || "0", 10) || (await nextVersion(targetDir, docId));
  const versionedName = `${baseSlug}__${docId}__v${version}${ext}`;
  const targetPath = join(targetDir, versionedName);
  const relPath = relative(kbRoot, targetPath);

  const eligibility = ingestEligibility(ext);
  const willIngest = !noIngest && eligibility.canIngest;

  console.log("=== intake plan ===");
  console.log(`  source:        ${absSrc}`);
  console.log(`  sender:        tg-${senderUserId}${senderUserId === ownerId ? " (owner)" : ""}`);
  console.log(`  chat:          ${chatId ? `${tgPath(chatId)} (${chatType})` : "(DM)"}`);
  console.log(`  caption hints: ${JSON.stringify(hints)}`);
  console.log(`  target:        ${relPath}`);
  console.log(`  doc-id:        ${docId}`);
  console.log(`  version:       v${version}`);
  console.log(`  visibility:    ${decision.visibility}`);
  console.log(`  scope:         ${decision.scope}`);
  console.log(`  ingest:        ${willIngest ? `yes (${eligibility.parser})` : `no (${eligibility.reason || "disabled"})`}`);

  if (dryRun) {
    console.log("\n(dry-run, no changes made)");
    return;
  }

  // 1. Stage the file
  await mkdir(targetDir, { recursive: true });
  await copyFile(absSrc, targetPath);
  console.log(`\nstaged → ${relPath}`);

  // 2. Ingest if eligible
  let chunksWritten = 0;
  let ingestErrors = [];
  if (willIngest) {
    const sharedCtx = { docId, version, decision, hints, senderUserId, chatId, ownerId };
    if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
      const result = await ingestMarkdown(targetPath, sharedCtx);
      chunksWritten = result.chunksWritten;
      ingestErrors = result.errors;
    } else if (ext === ".pdf") {
      const result = await ingestPdf(targetPath, sharedCtx);
      chunksWritten = result.chunksWritten;
      ingestErrors = result.errors;
    } else if (ext === ".csv") {
      const result = await ingestCsv(targetPath, sharedCtx);
      chunksWritten = result.chunksWritten;
      ingestErrors = result.errors;
      console.log(`         (Q&A rows pre-seeded to cache.qa: ${result.cacheRowsSeeded})`);
    } else {
      ingestErrors.push(`parser for ${ext} not implemented yet`);
    }
    console.log(`ingested → ${chunksWritten} chunks, ${ingestErrors.length} errors`);
  }

  // 3. Audit log
  const logEntry = {
    ts: new Date().toISOString(),
    source: chatId ? "telegram" : "telegram-dm",
    sender_user_id: senderUserId,
    owner_id: ownerId,
    chat_id: chatId ?? null,
    chat_type: chatType,
    caption,
    caption_hints: hints,
    original_filename: origName,
    saved_path: relPath,
    format: ext.slice(1) || "(none)",
    doc_id: docId,
    version: `v${version}`,
    visibility: decision.visibility,
    scope: decision.scope,
    chunks_written: chunksWritten,
    chunks_status: willIngest
      ? (ingestErrors.length === 0 ? "ok" : "partial")
      : (eligibility.canIngest ? "skipped" : `pending-${ext.slice(1)}-support`),
    errors: ingestErrors,
  };
  await appendFile(
    join(kbRoot, "_meta", "upload-log.jsonl"),
    JSON.stringify(logEntry) + "\n",
  );
  console.log(`logged → _meta/upload-log.jsonl`);
}

function ingestEligibility(ext) {
  const supported = new Set([".md", ".markdown", ".txt", ".pdf", ".csv"]);
  const pending = new Set([".docx", ".html", ".htm"]);
  const storeOnly = new Set([".png", ".jpg", ".jpeg", ".heic", ".mp3", ".ogg", ".wav", ".m4a", ".mp4", ".mov"]);
  if (supported.has(ext)) {return { canIngest: true, parser: ext.replace(".", "") };}
  if (pending.has(ext)) {return { canIngest: false, reason: `${ext.slice(1)} parser not yet implemented` };}
  if (storeOnly.has(ext)) {return { canIngest: false, reason: "store-only (media)" };}
  return { canIngest: false, reason: "unsupported extension" };
}

async function ingestMarkdown(absPath, { docId, version, decision, hints, senderUserId, chatId, ownerId }) {
  const raw = await readFile(absPath, "utf8");
  const sections = splitMarkdown(raw);
  let ok = 0;
  const errors = [];
  const anchors = {};
  anchors.sender_label = `kb:${docId}`;
  if (decision.scope === "chat" && chatId) {anchors.chat_id = tgPath(chatId);}
  if (decision.scope === "user" && senderUserId !== ownerId) {
    anchors.sender_id = `tg-${senderUserId}`;
  }
  if (decision.visibility !== "public") {anchors.visibility = decision.visibility;}
  if (hints.topic) {anchors.scope = hints.topic;}

  for (const [idx, sec] of sections.entries()) {
    const sourceRef = `${docId}:v${version}:${sec.heading || `section-${idx + 1}`}`;
    const text = sec.heading ? `${sec.heading}\n\n${sec.body}` : sec.body;
    try {
      const r = await fetch(`${apiBase}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-token": dashToken },
        body: JSON.stringify({
          text,
          source: `kb:${docId}`,
          sourceRef,
          kind: "knowledge",
          agentId: "main",
          importance: 0.7,
          retentionClass: "pinned",
          anchors,
        }),
      });
      if (!r.ok) {throw new Error(`HTTP ${r.status}`);}
      const j = await r.json();
      if (j?.outcome?.decision === "accepted" || j?.outcome?.decision === "merged") {ok += 1;}
    } catch (err) {
      errors.push(`${sec.heading}: ${err.message}`);
    }
  }
  return { chunksWritten: ok, errors };
}

/* ---------------------------------- csv ----------------------------------- */
/**
 * CSV ingest with auto-detection of Q&A columns.
 *
 * If the CSV header contains a column matching /question|问|q/i AND another
 * matching /answer|答|a/i, the file is treated as a Q&A pre-seed:
 *   - Each row's `answer` is ingested as a knowledge chunk (with `question`
 *     prepended as the heading).
 *   - The (question, answer) pair is ALSO posted to /api/cache/store so
 *     `cache.qa` is primed — the most common student/customer Qs answer in
 *     ~50ms with 0 LLM tokens from the very first ask, no warm-up needed.
 *
 * If the CSV is a generic table (no Q&A columns), each row becomes a chunk
 * formatted as `<col1>: <val1> / <col2>: <val2> / ...`.
 *
 * Topic per row: an optional `topic` / `category` column wins, else falls
 * back to the doc-level topic from caption hints.
 */
async function ingestCsv(absPath, ctx) {
  const { docId, version, decision, hints, senderUserId, chatId, ownerId } = ctx;
  const { parse } = await import("csv-parse/sync");
  const raw = await readFile(absPath, "utf8");
  let rows;
  try {
    rows = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
  } catch (err) {
    return { chunksWritten: 0, cacheRowsSeeded: 0, errors: [`csv-parse failed: ${err.message}`] };
  }
  if (rows.length === 0) {
    return { chunksWritten: 0, cacheRowsSeeded: 0, errors: ["csv has zero data rows"] };
  }
  const headers = Object.keys(rows[0]);
  const qCol = headers.find((h) => /^(question|q|问题?|提问)$/i.test(h));
  const aCol = headers.find((h) => /^(answer|a|答案?|回答)$/i.test(h));
  const topicCol = headers.find((h) => /^(topic|category|话题|分类)$/i.test(h));

  const anchors = buildAnchors(ctx);
  let chunksWritten = 0;
  let cacheRowsSeeded = 0;
  const errors = [];

  for (const [idx, row] of rows.entries()) {
    const rowTopic = (topicCol && row[topicCol]) || hints.topic || null;

    // Build text for ingest chunk.
    let text;
    let sourceRef;
    if (qCol && aCol) {
      const q = String(row[qCol] ?? "").trim();
      const a = String(row[aCol] ?? "").trim();
      if (!q || !a) {continue;}
      text = `Q: ${q}\nA: ${a}`;
      sourceRef = `${docId}:v${version}:row:${idx + 1}`;

      // Pre-seed cache.qa
      try {
        const cacheR = await fetch(`${apiBase}/api/cache/store`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-token": dashToken },
          body: JSON.stringify({
            agentId: "main",
            question: q,
            answer: a,
            answerFormat: "plain",
            scope: {
              chatId: anchors.chat_id,
              senderId: anchors.sender_id,
              visibility: anchors.visibility ?? "public",
            },
            topicTag: rowTopic,
            source: "csv-seed",
            sourceDocId: docId,
            ttlDays: 365, // CSV-seeded entries are curated; longer TTL
          }),
        });
        if (cacheR.ok) {cacheRowsSeeded += 1;}
      } catch (err) {
        errors.push(`row:${idx + 1} cache-seed: ${err.message}`);
      }
    } else {
      // Generic row — flatten as "col: val | col: val" for ingest.
      const parts = headers.filter((h) => row[h]).map((h) => `${h}: ${row[h]}`);
      text = parts.join(" | ");
      sourceRef = `${docId}:v${version}:row:${idx + 1}`;
      if (text.length < 80) {continue;}
    }

    try {
      const r = await fetch(`${apiBase}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-token": dashToken },
        body: JSON.stringify({
          text,
          source: `kb:${docId}`,
          sourceRef,
          kind: "knowledge",
          agentId: "main",
          importance: 0.7,
          retentionClass: "pinned",
          anchors: { ...anchors, ...(rowTopic ? { scope: rowTopic } : {}) },
        }),
      });
      if (!r.ok) {throw new Error(`HTTP ${r.status}`);}
      const j = await r.json();
      if (j?.outcome?.decision === "accepted" || j?.outcome?.decision === "merged") {chunksWritten += 1;}
    } catch (err) {
      errors.push(`row:${idx + 1} ingest: ${err.message}`);
    }
  }

  return { chunksWritten, cacheRowsSeeded, errors };
}

/* ---------------------------------- pdf ----------------------------------- */
/**
 * Extract PDF text via pdf-parse, then split into page-aware chunks.
 *
 * pdf-parse delivers ALL extracted text as one long string; pages are
 * separated by form-feed (\f). We:
 *   1. Split on \f → array of per-page strings.
 *   2. Within each page, split by paragraph (double blank lines) and
 *      group paragraphs until the chunk hits ~1500 chars.
 *   3. Drop chunks shorter than 80 chars (page headers, footers).
 *   4. source_ref carries "page:N" so the agent can cite back.
 *
 * Note: pure-text PDFs only. Scanned-image PDFs need OCR — that's a
 * future enhancement via credbroker's ASR-style service or tesseract.
 */
async function ingestPdf(absPath, ctx) {
  const { docId, version, decision, hints, senderUserId, chatId, ownerId } = ctx;
  const pdfModule = await import("pdf-parse").then((m) => m.default ?? m);
  const buf = await readFile(absPath);
  let parsed;
  try {
    parsed = await pdfModule(buf);
  } catch (err) {
    return { chunksWritten: 0, errors: [`pdf-parse failed: ${err.message}`] };
  }
  const pages = (parsed.text ?? "").split("\f");
  const anchors = buildAnchors(ctx);

  let ok = 0;
  const errors = [];
  for (const [pageIdx, pageRaw] of pages.entries()) {
    const pageNum = pageIdx + 1;
    const pageText = pageRaw.replace(/ /g, "").trim();
    if (pageText.length < 80) {continue;}
    const chunks = splitByParagraph(pageText, 1500);
    for (const [secIdx, body] of chunks.entries()) {
      if (body.length < 80) {continue;}
      const sourceRef = `${docId}:v${version}:page:${pageNum}${chunks.length > 1 ? `:s${secIdx + 1}` : ""}`;
      const text = `[page ${pageNum}]\n\n${body}`;
      try {
        const r = await fetch(`${apiBase}/api/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-token": dashToken },
          body: JSON.stringify({
            text,
            source: `kb:${docId}`,
            sourceRef,
            kind: "knowledge",
            agentId: "main",
            importance: 0.7,
            retentionClass: "pinned",
            anchors,
          }),
        });
        if (!r.ok) {throw new Error(`HTTP ${r.status}`);}
        const j = await r.json();
        if (j?.outcome?.decision === "accepted" || j?.outcome?.decision === "merged") {ok += 1;}
      } catch (err) {
        errors.push(`page:${pageNum}:s${secIdx + 1} → ${err.message}`);
      }
    }
  }
  return { chunksWritten: ok, errors };
}

function buildAnchors({ docId, decision, hints, senderUserId, chatId, ownerId }) {
  const anchors = { sender_label: `kb:${docId}` };
  if (decision.scope === "chat" && chatId) {anchors.chat_id = tgPath(chatId);}
  if (decision.scope === "user" && senderUserId !== ownerId) {anchors.sender_id = `tg-${senderUserId}`;}
  if (decision.visibility !== "public") {anchors.visibility = decision.visibility;}
  if (hints.topic) {anchors.scope = hints.topic;}
  return anchors;
}

function splitByParagraph(body, maxChars = 1500) {
  // Split on blank-line paragraph boundaries; combine paragraphs into
  // chunks of up to maxChars while keeping paragraph boundaries intact.
  const paragraphs = body.split(/\n\s*\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
  const out = [];
  let buf = [];
  let bufLen = 0;
  for (const p of paragraphs) {
    if (bufLen + p.length > maxChars && buf.length > 0) {
      out.push(buf.join("\n\n"));
      buf = [p]; bufLen = p.length;
    } else {
      buf.push(p); bufLen += p.length + 2;
    }
  }
  if (buf.length > 0) {out.push(buf.join("\n\n"));}
  return out;
}

function splitMarkdown(body, maxChars = 1500) {
  const lines = body.split("\n");
  const sections = [];
  let currentHeading = "";
  let currentBody = [];
  const flush = () => {
    const text = currentBody.join("\n").trim();
    if (text.length > 0) {sections.push({ heading: currentHeading, body: text });}
    currentBody = [];
  };
  for (const line of lines) {
    const m = /^(##{1,2})\s+(.+)$/.exec(line);
    if (m && !line.startsWith("####")) {
      flush();
      currentHeading = m[2].trim();
      continue;
    }
    currentBody.push(line);
  }
  flush();
  const out = [];
  for (const sec of sections) {
    if (sec.body.length <= maxChars) {out.push(sec); continue;}
    const paragraphs = sec.body.split(/\n\n+/);
    let buf = [];
    let bufLen = 0;
    for (const p of paragraphs) {
      if (bufLen + p.length > maxChars && buf.length > 0) {
        out.push({ heading: sec.heading, body: buf.join("\n\n") });
        buf = [p]; bufLen = p.length;
      } else {
        buf.push(p); bufLen += p.length;
      }
    }
    if (buf.length > 0) {out.push({ heading: sec.heading, body: buf.join("\n\n") });}
  }
  return out.filter((s) => s.body.length >= 80);
}

await main();
