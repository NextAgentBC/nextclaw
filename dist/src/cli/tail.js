/**
 * `openclaw memory tail` — colourised live stream of audit events.
 *
 * Subscribes to PG `LISTEN audit_events` and prints one line per event.
 * Filtering is applied client-side so the SQL stays simple.
 */
const COLOR = {
    reset: "[0m",
    dim: "[2m",
    bold: "[1m",
    red: "[31m",
    green: "[32m",
    yellow: "[33m",
    blue: "[34m",
    magenta: "[35m",
    cyan: "[36m",
};
function color(c, s) {
    return `${COLOR[c]}${s}${COLOR.reset}`;
}
function formatLine(e) {
    const ts = new Date(e.ts).toISOString().slice(11, 19);
    if (e.table === "ingest_decisions") {
        const tag = e.decision === "rejected"
            ? color("red", "REJECT")
            : e.decision === "merged"
                ? color("yellow", "MERGE ")
                : e.decision === "quarantined"
                    ? color("magenta", "QUAR  ")
                    : color("green", "ACCEPT");
        const path = color("dim", e.ingest_path ?? "?");
        const score = e.score == null
            ? ""
            : ` ${color("dim", `score=${e.score.toFixed(1)}`)}`;
        return `${color("dim", ts)}  ${tag}  ${path}${score}`;
    }
    const tier = e.hit_tier ?? "?";
    const tierColor = tier === "t0" || tier === "t1" ? "cyan"
        : tier.startsWith("t2") ? "yellow"
            : "magenta";
    const tag = color(tierColor, `RECALL ${tier.padEnd(9)}`);
    const score = e.score == null
        ? ""
        : ` ${color("dim", `score=${e.score.toFixed(1)}`)}`;
    const returned = e.returned == null
        ? ""
        : ` ${color("dim", `returned=${e.returned}`)}`;
    return `${color("dim", ts)}  ${tag}${returned}${score}`;
}
function shouldShow(e, filter) {
    switch (filter) {
        case "all": return true;
        case "rejected": return e.table === "ingest_decisions" && e.decision === "rejected";
        case "accepted": return e.table === "ingest_decisions" && e.decision === "accepted";
        case "recall": return e.table === "recall_decisions";
        case "ingest": return e.table === "ingest_decisions";
        default: return true;
    }
}
/**
 * Long-lived tail. Resolves only when the returned `stop()` is called.
 * Tests inject `out` to capture lines deterministically.
 */
export async function startTail(pool, options = {}) {
    const filter = options.filter ?? "all";
    const out = options.out ?? ((line) => process.stdout.write(`${line}\n`));
    const client = await pool.connect();
    client.on("notification", (msg) => {
        if (msg.channel !== "audit_events" || !msg.payload) {
            return;
        }
        try {
            const event = JSON.parse(msg.payload);
            if (shouldShow(event, filter)) {
                out(formatLine(event));
            }
        }
        catch {
            /* ignore */
        }
    });
    await client.query("LISTEN audit_events");
    return {
        async stop() {
            try {
                await client.query("UNLISTEN audit_events");
            }
            finally {
                client.release();
            }
        },
    };
}
export const _internal = { formatLine, shouldShow };
