// Memory dashboard front-end (no framework).
// Token: ?token=XXX in URL is captured into sessionStorage and forwarded
// on every API + SSE call as X-Token (or query for SSE which can't custom-header).

const TOKEN_KEY = "memdash:token";
const urlParams = new URLSearchParams(location.search);
const tokenFromUrl = urlParams.get("token");
if (tokenFromUrl) {
  sessionStorage.setItem(TOKEN_KEY, tokenFromUrl);
  urlParams.delete("token");
  const cleanQuery = urlParams.toString();
  const cleanUrl = location.pathname + (cleanQuery ? `?${cleanQuery}` : "") + location.hash;
  history.replaceState(null, "", cleanUrl);
}
const TOKEN = sessionStorage.getItem(TOKEN_KEY);
const headers = TOKEN ? { "X-Token": TOKEN } : {};
const sseUrl = (path) => (TOKEN ? `${path}?token=${encodeURIComponent(TOKEN)}` : path);
const apiFetch = (path, init = {}) =>
  fetch(path, { ...init, headers: { ...(init.headers ?? {}), ...headers } });

const $ = (id) => document.getElementById(id);

// ---------- bilingual dictionaries ----------
// Keep English token (used as CSS class) + 中文 label. Rendered as
// "中文·en" in compact spots, "英文 · 中文" in roomier spots.
const DECISION_CN = {
  accepted: "接受",
  rejected: "拒绝",
  merged: "合并",
  quarantined: "隔离",
};
const PATH_CN = {
  deterministic: "确定性",
  sidecar: "侧车",
  cache: "缓存",
  llm_residual: "LLM残差",
};
const TIER_CN = {
  t0: "工作记忆",
  t1: "热缓存",
  t2_anchor: "锚点直查",
  t2_hybrid: "混合检索",
  t2_full: "全管道",
  t3: "冷归档",
};
const CATEGORY_CN = {
  health: "健康",
  medical: "医疗",
  tech: "科技",
  life: "生活",
  work: "工作",
  finance: "财务",
  other: "其他",
};
const labelDecision = (k) => `${DECISION_CN[k] ?? k}·${k}`;
const labelPath = (k) => `${PATH_CN[k] ?? k}·${k}`;
const labelTier = (k) => `${TIER_CN[k] ?? k}·${k}`;
const labelCategory = (k) => `${CATEGORY_CN[k] ?? k}·${k}`;

// ---------- formatting helpers ----------
const fmt = (n) => (n == null || Number.isNaN(Number(n)) ? "—" : Number(n).toFixed(1));
const fmtInt = (n) => (n == null ? "—" : String(Number(n) | 0));
const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");
const timeShort = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });

function scoreClass(score) {
  if (score == null) return "";
  if (score >= 70) return "score-ok";
  if (score >= 40) return "score-mid";
  return "score-bad";
}
function tierGroup(tier) {
  if (!tier) return "t2";
  if (tier === "t0") return "t0";
  if (tier === "t1") return "t1";
  if (tier === "t3") return "t3";
  return "t2";
}

// ---------- KPI updaters ----------
function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text ?? "—";
}

function updateKpis(stats, recent) {
  const counts = stats.ingestCounts ?? {};
  const accepted = Number(counts.accepted ?? 0);
  const rejected = Number(counts.rejected ?? 0);
  const merged   = Number(counts.merged ?? 0);
  const quar     = Number(counts.quarantined ?? 0);
  const totalIngests = accepted + rejected + merged + quar;
  setText("kpi-ingests", String(totalIngests));
  setText("kpi-ingest-detail",
    totalIngests
      ? `✓${accepted} 接受  ✗${rejected} 拒绝  ⇄${merged} 合并  ?${quar} 隔离`
      : "暂无事件 · no events");

  const recallTiers = stats.recallTiers ?? [];
  const totalRecalls = recallTiers.reduce((acc, r) => acc + Number(r.n ?? 0), 0);
  setText("kpi-recalls", String(totalRecalls));
  if (totalRecalls > 0) {
    const top = recallTiers.slice(0, 3).map((r) => `${labelTier(r.hit_tier)}:${r.n}`).join("  ");
    setText("kpi-recall-detail", top);
  } else {
    setText("kpi-recall-detail", "暂无事件 · no events");
  }

  // average score from recall hourly rows
  const recallRows = (stats.hourly ?? []).filter((r) => r.op === "recall");
  if (recallRows.length > 0) {
    const totalN = recallRows.reduce((a, r) => a + Number(r.n ?? 0), 0);
    const wAvg = recallRows.reduce((a, r) => a + Number(r.avg_score ?? 0) * Number(r.n ?? 0), 0) / Math.max(1, totalN);
    setText("kpi-recall-score", fmt(wAvg));
    const wLat = recallRows.reduce((a, r) => a + Number(r.avg_latency_ms ?? 0) * Number(r.n ?? 0), 0) / Math.max(1, totalN);
    setText("kpi-recall-lat", `${fmt(wLat)}`);
  } else {
    setText("kpi-recall-score", "—");
    setText("kpi-recall-lat", "—");
  }

  // tokens + embed calls (sum all hourly)
  const allRows = stats.hourly ?? [];
  const tokensSum = allRows.reduce((a, r) => a + Number(r.avg_tokens ?? 0) * Number(r.n ?? 0), 0);
  setText("kpi-tokens", fmtInt(Math.round(tokensSum)));

  const recallList = recent.recalls ?? [];
  const embedSum = recallList.reduce((a, r) => a + Number(r.embed_calls ?? 0), 0);
  setText("kpi-embed", fmtInt(embedSum));
}

function renderBars(elId, items, classMap) {
  const el = $(elId);
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="muted" style="text-align:center; padding: 10px;">暂无 · no data</div>';
    return;
  }
  const max = Math.max(...items.map((it) => Number(it.n ?? 0)), 1);
  el.innerHTML = items
    .map((it) => {
      const n = Number(it.n ?? 0);
      const pct = (n / max) * 100;
      const cls = classMap(it);
      return `
        <div class="bar ${cls}">
          <span class="label">${escapeHtml(it.label)}</span>
          <span class="track"><span class="fill" style="width:${pct}%"></span></span>
          <span class="count">${n}</span>
        </div>`;
    })
    .join("");
}

// ---------- category pill rendering for table cells / live stream ----------
function categoryPills(cats) {
  if (!cats || cats.length === 0) return '<span class="muted">—</span>';
  return cats
    .map((c) => {
      const isPriv = c === "health" || c === "medical";
      const lock = isPriv ? "🔒 " : "";
      return `<span class="cat-pill cat-${c}" title="${labelCategory(c)}">${lock}${CATEGORY_CN[c] ?? c}</span>`;
    })
    .join(" ");
}

// ---------- ingest row ----------
function renderIngestRow(r) {
  const cats = r.categories ?? [];
  const sensitive = cats.includes("health") || cats.includes("medical");
  const excerptText = r.text_excerpt ?? "";
  const excerptHtml = sensitive
    ? `<span class="redacted">🔒 ${escapeHtml(excerptText)}</span>`
    : escapeHtml(truncate(excerptText, 110));
  return `<tr class="${sensitive ? "row-sensitive" : ""}">
    <td>${timeShort(r.ts)}</td>
    <td><span class="decision-badge ${r.decision}">${labelDecision(r.decision)}${
      r.reject_reason ? ` · ${r.reject_reason}` : ""
    }</span></td>
    <td><span class="muted">${labelPath(r.ingest_path ?? "—")}</span></td>
    <td class="cats">${categoryPills(cats)}</td>
    <td class="num">${fmtInt(r.llm_tokens_used)}</td>
    <td class="num">${fmtInt(r.latency_ms)} ms</td>
    <td class="num ${scoreClass(r.score)}">${fmt(r.score)}</td>
    <td class="excerpt">${excerptHtml}</td>
  </tr>`;
}

function renderRecallRow(r) {
  return `<tr>
    <td>${timeShort(r.ts)}</td>
    <td><span class="tier-badge ${tierGroup(r.hit_tier)}">${labelTier(r.hit_tier ?? "?")}</span></td>
    <td class="num">${fmtInt(r.returned)}</td>
    <td class="num">${fmtInt(r.llm_tokens_used)}</td>
    <td class="num">${fmtInt(r.embed_calls)}</td>
    <td class="num">${fmtInt(r.latency_ms)} ms</td>
    <td class="num ${scoreClass(r.score)}">${fmt(r.score)}</td>
    <td class="query">${escapeHtml(truncate(r.query_text ?? "", 120))}</td>
  </tr>`;
}

// ---------- bot stats ----------
function fmtMs(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v.toFixed(0)} ms`;
}
function fmtThou(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "0";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)} K`;
  return String(v | 0);
}

function updateBotStats(s) {
  if (!s || s.count == null) {
    setText("bot-count", "—");
    setText("bot-p50", "—");
    setText("bot-p90", "—");
    setText("bot-max", "—");
    setText("bot-cold", "—");
    setText("bot-out", "—");
    setText("bot-in", "—");
    setText("bot-cache", "—");
    const body = $("bot-table")?.querySelector("tbody");
    if (body) body.innerHTML = '<tr class="empty"><td colspan="8">trajectory 文件不可读 · trajectory unavailable</td></tr>';
    return;
  }
  setText("bot-count", String(s.count));
  setText("bot-p50", fmtMs(s.p50LatencyMs));
  setText("bot-p90", fmtMs(s.p90LatencyMs));
  setText("bot-max", fmtMs(s.maxLatencyMs));
  setText("bot-cold", `${s.coldStartPct ?? 0}%`);
  setText("bot-out", fmtThou(s.totalOutputTokens));
  setText("bot-in", fmtThou(s.totalInputTokens));
  setText("bot-cache", fmtThou(s.totalCacheReadTokens));
  const meta = $("bot-stats-meta");
  if (meta) meta.textContent = `last 24h · ${s.provider ?? "?"}/${s.modelId ?? "?"} · ${s.count} turns`;
  const body = $("bot-table").querySelector("tbody");
  if (s.recent.length === 0) {
    body.innerHTML = '<tr class="empty"><td colspan="8">暂无 turn · no turns yet</td></tr>';
    return;
  }
  body.innerHTML = s.recent
    .map((t) => {
      const tools = t.toolNames && t.toolNames.length
        ? t.toolNames
            .slice(0, 3)
            .map((n) => `<span class="tool-chip">${escapeHtml(n)}</span>`)
            .join(" ") + (t.toolNames.length > 3 ? ` <span class="muted">+${t.toolNames.length - 3}</span>` : "")
        : '<span class="muted">—</span>';
      return `<tr>
        <td>${timeShort(t.startedAt)}</td>
        <td class="num">${fmtMs(t.modelLatencyMs)}</td>
        <td class="num">${fmtMs(t.totalLatencyMs)}</td>
        <td class="num">${fmtThou(t.inputTokens)}</td>
        <td class="num">${fmtThou(t.outputTokens)}</td>
        <td class="num">${fmtThou(t.cacheReadTokens)}</td>
        <td>${t.coldStart ? '<span class="cold-flag">❄ cold</span>' : '<span class="muted">warm</span>'}</td>
        <td>${tools}</td>
      </tr>`;
    })
    .join("");
}

// ---------- model comparison ----------
function updateCompare(data) {
  const aggsEl = $("compare-aggregates");
  const body = $("compare-table")?.querySelector("tbody");
  if (!data || !aggsEl || !body) return;
  const aggs = data.aggregates ?? [];
  const recent = data.recent ?? [];

  if (aggs.length === 0) {
    aggsEl.innerHTML =
      '<div class="compare-empty">尚无影子对比数据 — 启动 shadow-comparator 后此处会出现。<br>' +
      '<span class="muted">No shadow data yet — start the shadow comparator to populate this panel.</span></div>';
  } else {
    aggsEl.innerHTML = aggs
      .map((a) => {
        const ratio = Number(a.speed_ratio_avg) || 0;
        const verdict =
          ratio >= 1.5 ? '<span class="ratio-fast">挑战者更快 ×' + ratio.toFixed(2) + '</span>'
          : ratio >= 1.0 ? '<span class="ratio-mid">略快 ×' + ratio.toFixed(2) + '</span>'
          : '<span class="ratio-slow">较慢 ×' + ratio.toFixed(2) + '</span>';
        const ok = Number(a.ok_n) || 0;
        const err = Number(a.err_n) || 0;
        const okPct = ok + err > 0 ? ((ok / (ok + err)) * 100).toFixed(0) : "0";
        return `
          <div class="agg-card">
            <div class="agg-head">
              <strong>${escapeHtml(a.ch_model)}</strong>
              <span class="muted">${a.n} 次</span>
            </div>
            <div class="agg-row">
              <span class="muted">gpt-5.5 平均</span>
              <strong>${a.base_avg_ms} ms</strong>
            </div>
            <div class="agg-row">
              <span class="muted">挑战者平均</span>
              <strong>${a.ch_avg_ms} ms</strong>
            </div>
            <div class="agg-row big">
              <span class="muted">速度比</span>
              ${verdict}
            </div>
            <div class="agg-row">
              <span class="muted">成功率</span>
              <strong>${okPct}%</strong>
              ${err > 0 ? `<span class="muted">(${err} err)</span>` : ""}
            </div>
            <div class="agg-row">
              <span class="muted">tokens out (24h)</span>
              <span>base=${fmtThou(a.base_out_sum)} · ch=${fmtThou(a.ch_out_sum)}</span>
            </div>
          </div>`;
      })
      .join("");
  }

  if (recent.length === 0) {
    body.innerHTML = '<tr class="empty"><td colspan="8">暂无影子对比数据 · no shadow data yet</td></tr>';
    return;
  }
  body.innerHTML = recent
    .map((r) => {
      const ratio = Number(r.speed_ratio);
      const ratioCls = !Number.isFinite(ratio) ? "" : ratio >= 1.5 ? "ratio-fast" : ratio >= 1.0 ? "ratio-mid" : "ratio-slow";
      const ratioTxt = Number.isFinite(ratio) ? `×${ratio.toFixed(2)}` : "—";
      const errMark = r.ch_error ? '<span class="cold-flag" style="background:rgba(240,104,104,0.18);color:var(--bad)" title="' + escapeHtml(r.ch_error) + '">err</span>' : "";
      return `<tr>
        <td>${timeShort(r.ts)}</td>
        <td class="user-msg">${escapeHtml(truncate(r.user_message ?? "", 70))}</td>
        <td class="num">${fmtInt(r.base_latency_ms)}</td>
        <td class="num">${fmtInt(r.ch_latency_ms)} ${errMark}</td>
        <td class="num ${ratioCls}">${ratioTxt}</td>
        <td class="num"><span class="muted">${fmtThou(r.base_in_tokens)}/${fmtThou(r.base_out_tokens)} · ${fmtThou(r.ch_in_tokens)}/${fmtThou(r.ch_out_tokens)}</span></td>
        <td class="excerpt base-out">${escapeHtml(truncate(r.base_output ?? "", 130))}</td>
        <td class="excerpt ch-out">${escapeHtml(truncate(r.ch_output ?? "", 130))}</td>
      </tr>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------- main refresh loop ----------
async function refresh() {
  try {
    const [stats, recent, botResp, compareResp] = await Promise.all([
      apiFetch("/api/stats").then((r) => {
        if (!r.ok) throw new Error(`stats ${r.status}`);
        return r.json();
      }),
      apiFetch("/api/recent").then((r) => {
        if (!r.ok) throw new Error(`recent ${r.status}`);
        return r.json();
      }),
      apiFetch("/api/bot-stats").then((r) => (r.ok ? r.json() : { ok: false })).catch(() => ({ ok: false })),
      apiFetch("/api/model-compare").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    updateKpis(stats, recent);
    updateBotStats(botResp.stats);
    updateCompare(compareResp);

    // Decision bars (bilingual labels)
    const counts = stats.ingestCounts ?? {};
    renderBars(
      "ingest-bars",
      ["accepted", "rejected", "merged", "quarantined"]
        .map((k) => ({ label: labelDecision(k), n: Number(counts[k] ?? 0), cls: k }))
        .filter((x) => x.n > 0)
        .toSorted((a, b) => b.n - a.n),
      (it) => it.cls,
    );

    // Tier bars (bilingual labels)
    renderBars(
      "recall-bars",
      (stats.recallTiers ?? []).map((r) => ({
        label: labelTier(r.hit_tier),
        n: Number(r.n),
        cls: tierGroup(r.hit_tier),
      })),
      (it) => it.cls,
    );

    // Category bars (taxonomy + bilingual labels + lock counts)
    const cats = stats.categories ?? [];
    renderBars(
      "category-bars",
      cats.map((r) => {
        const pinned = Number(r.pinned ?? 0);
        const lockSuffix = pinned > 0 ? ` · 🔒${pinned}` : "";
        return {
          label: `${labelCategory(r.category)}${lockSuffix}`,
          n: Number(r.n),
          cls: `cat-${r.category}`,
        };
      }),
      (it) => it.cls,
    );

    // Tables
    const ingestBody = $("ingest-table").querySelector("tbody");
    const recallBody = $("recall-table").querySelector("tbody");
    ingestBody.innerHTML = recent.ingests.length
      ? recent.ingests.map(renderIngestRow).join("")
      : '<tr class="empty"><td colspan="8">暂无录入事件 · no ingest events yet</td></tr>';
    recallBody.innerHTML = recent.recalls.length
      ? recent.recalls.map(renderRecallRow).join("")
      : '<tr class="empty"><td colspan="8">暂无召回事件 · no recall events yet</td></tr>';

    const status = $("status");
    status.textContent = `live · ${new Date().toLocaleTimeString([], { hour12: false })}`;
    status.classList.remove("error");
    status.classList.add("ok");
  } catch (err) {
    const status = $("status");
    status.textContent = `error · ${err.message}`;
    status.classList.add("error");
    status.classList.remove("ok");
    if (err.message.includes("401")) {
      status.textContent = "未授权 · unauthorized — open URL with ?token=...";
    }
  }
}

function startStream() {
  const es = new EventSource(sseUrl("/api/stream"));
  const ul = $("stream");

  es.addEventListener("audit", (msg) => {
    const data = JSON.parse(msg.data);
    const empty = ul.querySelector("li.empty");
    if (empty) ul.removeChild(empty);

    const li = document.createElement("li");
    if (data.table === "ingest_decisions") {
      const cls = data.decision || "accepted";
      li.className = cls;
      li.innerHTML = `
        <span class="dot"></span>
        <span class="ts">${timeShort(data.ts)}</span>
        <span class="body">
          <strong>${labelDecision(cls)}</strong>
          <span class="muted"> · ${labelPath(data.ingest_path ?? "?")}</span>
        </span>
        <span class="score">${data.score != null ? fmt(data.score) : ""}</span>`;
    } else {
      const grp = tierGroup(data.hit_tier);
      li.className = grp;
      li.innerHTML = `
        <span class="dot"></span>
        <span class="ts">${timeShort(data.ts)}</span>
        <span class="body">
          <span class="muted">召回·recall</span>
          <strong> ${labelTier(data.hit_tier ?? "?")}</strong>
          <span class="muted"> · returned=${data.returned ?? 0}</span>
        </span>
        <span class="score">${data.score != null ? fmt(data.score) : ""}</span>`;
    }
    ul.prepend(li);
    while (ul.children.length > 60) ul.removeChild(ul.lastChild);
  });

  es.addEventListener("hello", () => {
    const status = $("status");
    if (!status.classList.contains("error")) {
      status.textContent = "live · streaming";
      status.classList.add("ok");
    }
  });

  es.onerror = () => {
    const status = $("status");
    status.textContent = "stream disconnected · 重连中…";
    status.classList.remove("ok");
  };
}

refresh();
setInterval(refresh, 10_000);
startStream();
