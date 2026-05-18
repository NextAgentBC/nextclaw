/**
 * Temporal query parser — bilingual CN/EN.
 *
 * Recognises a handful of common relative-time expressions and converts
 * them to a list of `YYYY-MM-DD` time_bucket keys the router can pass to
 * `routeTimeBucket`. Deterministic regex + integer date math; no LLM.
 *
 * Supported (most-specific wins; first hit returns):
 *   - 今天 / today / today's        → [today]
 *   - 昨天 / yesterday              → [today-1]
 *   - 前天                          → [today-2]
 *   - N 天前 / N days ago           → [today-N]
 *   - 这周 / this week              → [Mon..Sun of current week]
 *   - 上周 / last week              → [Mon..Sun of previous week]
 *   - 上个月 / 上月 / last month    → last 30 days
 *   - 这个月 / 本月 / this month    → 1st..today of current month
 *   - "YYYY-MM-DD" / "YYYY年MM月DD日" → that single date
 *
 * Things deliberately NOT recognised (too wide / too ambiguous):
 *   - "去年", "next year", "soon", "在那天"
 *   - "in the past few weeks" — caller can pass timeBucket explicitly
 *
 * Returns `null` when the query has no temporal cue we can resolve.
 */
function dateBucket(d) {
    // ISO date in UTC, matching how ingest tags time_bucket values.
    return d.toISOString().slice(0, 10);
}
function daysAgo(now, n) {
    const d = new Date(now.getTime());
    d.setUTCDate(d.getUTCDate() - n);
    return d;
}
function bucketRange(start, end) {
    const out = [];
    let cur = new Date(start.getTime());
    while (cur <= end) {
        out.push(dateBucket(cur));
        cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
    }
    return out;
}
function startOfWeekUtc(d) {
    // ISO week — Monday-anchored.
    const day = d.getUTCDay(); // 0 (Sun) .. 6 (Sat)
    const offset = day === 0 ? -6 : 1 - day;
    const r = new Date(d.getTime());
    r.setUTCDate(r.getUTCDate() + offset);
    r.setUTCHours(0, 0, 0, 0);
    return r;
}
export function inferTimeBucketsFromQuery(query, now = new Date()) {
    const today = new Date(now.getTime());
    today.setUTCHours(0, 0, 0, 0);
    // Single-day matches: 今天 / today
    if (/(?:^|[^A-Za-z])today(?:$|[^A-Za-z])/i.test(query) || /今天|今儿/.test(query)) {
        return { buckets: [dateBucket(today)], matched: "today" };
    }
    if (/yesterday/i.test(query) || /昨天|昨儿/.test(query)) {
        return { buckets: [dateBucket(daysAgo(today, 1))], matched: "yesterday" };
    }
    if (/前天/.test(query)) {
        return { buckets: [dateBucket(daysAgo(today, 2))], matched: "前天" };
    }
    if (/大前天/.test(query)) {
        return { buckets: [dateBucket(daysAgo(today, 3))], matched: "大前天" };
    }
    // "N days ago" / "N 天前"
    const nDaysCn = /(\d{1,3})\s*天前/.exec(query);
    if (nDaysCn) {
        const n = Math.max(0, Math.min(365, parseInt(nDaysCn[1], 10)));
        return { buckets: [dateBucket(daysAgo(today, n))], matched: `${n} days ago` };
    }
    const nDaysEn = /\b(\d{1,3})\s+days?\s+ago\b/i.exec(query);
    if (nDaysEn) {
        const n = Math.max(0, Math.min(365, parseInt(nDaysEn[1], 10)));
        return { buckets: [dateBucket(daysAgo(today, n))], matched: `${n} days ago` };
    }
    // Week-spanning
    if (/this week|本周|这周/i.test(query)) {
        const start = startOfWeekUtc(today);
        return { buckets: bucketRange(start, today), matched: "this week" };
    }
    if (/last week|上周|上个礼拜|上礼拜/i.test(query)) {
        const thisWeekStart = startOfWeekUtc(today);
        const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
        const lastWeekEnd = new Date(thisWeekStart.getTime() - 24 * 60 * 60 * 1000);
        return { buckets: bucketRange(lastWeekStart, lastWeekEnd), matched: "last week" };
    }
    // Month-spanning (approximate — last 30/this-month-up-to-today)
    if (/last month|上个月|上月/i.test(query)) {
        return { buckets: bucketRange(daysAgo(today, 30), daysAgo(today, 1)), matched: "last month" };
    }
    if (/this month|这个月|本月/i.test(query)) {
        const firstOfMonth = new Date(today.getTime());
        firstOfMonth.setUTCDate(1);
        return { buckets: bucketRange(firstOfMonth, today), matched: "this month" };
    }
    // Specific date — already in YYYY-MM-DD form (the existing single-bucket
    // path handles this when the caller passes ctx.timeBucket, but recognise
    // it in free-text queries too).
    const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(query);
    if (iso) {
        return { buckets: [`${iso[1]}-${iso[2]}-${iso[3]}`], matched: "explicit iso" };
    }
    // Chinese style "2026年5月16日"
    const cn = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(query);
    if (cn) {
        const y = cn[1];
        const m = cn[2].padStart(2, "0");
        const d = cn[3].padStart(2, "0");
        return { buckets: [`${y}-${m}-${d}`], matched: "explicit cn date" };
    }
    return null;
}
