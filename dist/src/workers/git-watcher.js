/**
 * Plugin-internal git watcher.
 *
 * Polls a local git repo on a configurable interval, ingests every new
 * commit since `last_sha` (persisted in audit.plugin_meta), and bumps the
 * pointer. Fully deterministic — no agent, no LLM. The same chunk text is
 * exactly what `tools/git-corpus-ingest.mjs` produced earlier, so ingest
 * goes through the regular Stage 0–6 pipeline + multi-key indexes.
 *
 * Idempotent: `sourceRef` is the commit sha. If the same commit gets seen
 * twice (e.g. fresh start or recovery after crash), the unique index on
 * `(text_hash, source)` dedup-merges instead of inserting.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ingestOne } from "../ingest/pipeline.js";
const execFileP = promisify(execFile);
const META_KEY = (watcherId) => `git_watcher.${watcherId}.last_sha`;
const COMMIT_DELIM = "<<<COMMIT_START>>>";
const FIELD_DELIM = "<<<FIELD>>>";
const FILES_DELIM = "<<<FILES>>>";
/* --------------------------------- helpers -------------------------------- */
async function readLastSha(pool, watcherId) {
    const rows = await pool.query("SELECT value FROM audit.plugin_meta WHERE key = $1", [META_KEY(watcherId)]);
    return rows.rows[0]?.value?.sha ?? null;
}
async function writeLastSha(pool, watcherId, sha) {
    await pool.query(`INSERT INTO audit.plugin_meta (key, value, updated_at)
       VALUES ($1, jsonb_build_object('sha', $2::text), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [META_KEY(watcherId), sha]);
}
function makeRunner(watcher) {
    return async (args) => {
        const { stdout } = await execFileP(watcher.gitBinary, ["-C", watcher.path, ...args], {
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    };
}
/**
 * Parse `git log` output that uses our explicit delimiters. Fragile to
 * commit message contents → we use sentinels that won't appear in real
 * messages.
 */
export function parseCommits(raw) {
    const blocks = raw.split(COMMIT_DELIM).map((b) => b.trim()).filter(Boolean);
    const out = [];
    for (const block of blocks) {
        const [head, filesPart = ""] = block.split(FILES_DELIM);
        if (!head) {
            continue;
        }
        const fields = head.split(FIELD_DELIM);
        if (fields.length < 6) {
            continue;
        }
        const sha = fields[0].trim();
        const isoDate = fields[1].trim();
        const author = fields[2].trim();
        const authorEmail = fields[3].trim();
        const subject = fields[4].trim();
        const body = fields[5].trim();
        const files = filesPart
            .split("\n")
            .map((f) => f.trim())
            .filter((f) => f.length > 0);
        if (sha) {
            out.push({ sha, isoDate, author, authorEmail, subject, body, files });
        }
    }
    return out;
}
function formatChunk(c) {
    const head = `[${c.author}] ${c.subject}`;
    const body = c.body && c.body !== c.subject ? `\n${c.body.slice(0, 800)}` : "";
    const filesLine = c.files.length === 0 ? "" : `\nfiles: ${c.files.slice(0, 8).join(", ")}`;
    return `${head}${body}${filesLine}`;
}
function extractPrNumber(c) {
    const m = /\(?#(\d{3,6})\)?/u.exec(`${c.subject}\n${c.body}`);
    return m ? m[1] : undefined;
}
/* ----------------------------- main poll cycle ---------------------------- */
export async function pollGitWatcher(deps) {
    const { cfg, pool, embedding, watcher } = deps;
    const log = deps.logger ?? { info: () => undefined, warn: () => undefined };
    const run = deps.runGit ?? makeRunner(watcher);
    const errors = [];
    const fromSha = await readLastSha(pool, watcher.id);
    let toSha;
    // 1. Update local refs.
    try {
        await run(["fetch", watcher.remote, watcher.branch, "--prune"]);
    }
    catch (err) {
        errors.push(`fetch failed: ${err.message}`);
        return {
            watcherId: watcher.id,
            fromSha,
            toSha: fromSha ?? "",
            commitsSeen: 0,
            commitsAccepted: 0,
            commitsMerged: 0,
            commitsRejected: 0,
            errors,
            hadNewCommits: false,
        };
    }
    try {
        toSha = (await run(["rev-parse", `${watcher.remote}/${watcher.branch}`])).trim();
    }
    catch (err) {
        errors.push(`rev-parse failed: ${err.message}`);
        return {
            watcherId: watcher.id,
            fromSha,
            toSha: fromSha ?? "",
            commitsSeen: 0,
            commitsAccepted: 0,
            commitsMerged: 0,
            commitsRejected: 0,
            errors,
            hadNewCommits: false,
        };
    }
    if (fromSha && fromSha === toSha) {
        return {
            watcherId: watcher.id,
            fromSha,
            toSha,
            commitsSeen: 0,
            commitsAccepted: 0,
            commitsMerged: 0,
            commitsRejected: 0,
            errors,
            hadNewCommits: false,
        };
    }
    // 2. Pull new commits since last seen — bounded to 200 to keep one tick small.
    const range = fromSha ? `${fromSha}..${toSha}` : `${toSha}~50..${toSha}`;
    const fmt = [
        `${COMMIT_DELIM}%H`,
        `%aI`,
        `%an`,
        `%ae`,
        `%s`,
        `%b`,
    ].join(FIELD_DELIM);
    const logOut = await run([
        "log",
        range,
        "--no-merges",
        `--pretty=format:${fmt}${FILES_DELIM}`,
        "--name-only",
        "--max-count=200",
    ]);
    const commits = parseCommits(logOut);
    if (commits.length === 0) {
        await writeLastSha(pool, watcher.id, toSha);
        return {
            watcherId: watcher.id,
            fromSha,
            toSha,
            commitsSeen: 0,
            commitsAccepted: 0,
            commitsMerged: 0,
            commitsRejected: 0,
            errors,
            hadNewCommits: false,
        };
    }
    // 3. Ingest each commit. git log is newest-first; reverse so chunks land
    //    in chronological order (helps later time-based queries / dreaming).
    const ordered = [...commits].toReversed();
    let accepted = 0;
    let merged = 0;
    let rejected = 0;
    for (const c of ordered) {
        try {
            const input = {
                text: formatChunk(c),
                source: watcher.source,
                sourceRef: c.sha.slice(0, 12),
                kind: "fact",
                agentSessionId: undefined,
                anchors: {
                    cwd: watcher.anchors.cwd,
                    branch: watcher.anchors.branch,
                    pr: extractPrNumber(c),
                },
                now: new Date(c.isoDate),
            };
            const outcome = await ingestOne({ cfg, pool, embedding }, input);
            if (outcome.decision === "accepted") {
                accepted += 1;
            }
            else if (outcome.decision === "merged") {
                merged += 1;
            }
            else if (outcome.decision === "rejected") {
                rejected += 1;
            }
        }
        catch (err) {
            errors.push(`commit ${c.sha.slice(0, 8)}: ${err.message}`);
        }
    }
    // 4. Persist new last_sha so the next tick is incremental.
    await writeLastSha(pool, watcher.id, toSha);
    log.info(`git-watcher[${watcher.id}]: ingested ${accepted} new + ${merged} merged + ${rejected} rejected `
        + `(range ${fromSha?.slice(0, 8) ?? "INIT"}..${toSha.slice(0, 8)})`);
    return {
        watcherId: watcher.id,
        fromSha,
        toSha,
        commitsSeen: commits.length,
        commitsAccepted: accepted,
        commitsMerged: merged,
        commitsRejected: rejected,
        errors,
        hadNewCommits: true,
    };
}
export function startGitWatcherDaemon(deps) {
    const log = deps.logger ?? { info: () => undefined, warn: () => undefined };
    let stopped = false;
    let timer = null;
    const tick = async () => {
        if (stopped) {
            return;
        }
        try {
            await pollGitWatcher(deps);
        }
        catch (err) {
            log.warn(`git-watcher[${deps.watcher.id}] tick failed: ${err.message}`);
        }
    };
    // Kick off shortly after start so the first day isn't empty, then on interval.
    setTimeout(() => void tick(), 30 * 1000);
    timer = setInterval(() => void tick(), Math.max(60_000, deps.watcher.intervalMs));
    return {
        watcherId: deps.watcher.id,
        stop() {
            stopped = true;
            if (timer) {
                clearInterval(timer);
            }
            timer = null;
        },
    };
}
