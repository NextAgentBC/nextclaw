/**
 * Doctor checks for memory-postgres.
 *
 * Used by `openclaw doctor` (when wired in Phase 4 CLI registration). Each
 * probe is independent and returns a structured result so the parent doctor
 * UI can display fine-grained pass/fail.
 */
import { buildEmbeddingClientFromConfig, } from "./embedding/client.js";
import { resolveConfig, validateConfig } from "./config.js";
import { healthcheck } from "./storage/pool.js";
const REQUIRED_EXTENSIONS = new Set(["vector", "pg_trgm", "btree_gin"]);
export async function runDoctor(rawConfig) {
    const probes = [];
    // 1. Config shape.
    try {
        validateConfig(rawConfig);
    }
    catch (err) {
        probes.push({
            name: "config",
            ok: false,
            message: `config invalid: ${err.message}`,
        });
        return { ok: false, probes };
    }
    probes.push({
        name: "config",
        ok: true,
        message: "config schema OK",
    });
    const cfg = resolveConfig(rawConfig);
    // 2. Postgres reachability + extensions.
    const pg = await probePostgres(cfg.postgres);
    probes.push(pg);
    if (!pg.ok) {
        return { ok: false, probes };
    }
    // 3. Required extensions installed (separate sub-probe so the message is precise).
    if (pg.details && pg.details["extensions"]) {
        const exts = pg.details["extensions"];
        const missing = [...REQUIRED_EXTENSIONS].filter((name) => !exts[name]);
        probes.push({
            name: "pg.extensions",
            ok: missing.length === 0,
            message: missing.length === 0
                ? `extensions present: ${[...REQUIRED_EXTENSIONS].toSorted().join(", ")}`
                : `missing extensions: ${missing.join(", ")}`,
            details: { installed: exts, required: [...REQUIRED_EXTENSIONS] },
        });
    }
    // 4. Embedding endpoint.
    probes.push(await probeEmbedding(cfg.embedding));
    return { ok: probes.every((p) => p.ok), probes };
}
async function probePostgres(cfg) {
    const start = Date.now();
    const result = await healthcheck(cfg);
    if (!result.ok) {
        return {
            name: "pg.connect",
            ok: false,
            message: `connect failed: ${result.error ?? "unknown error"}`,
            details: { latencyMs: Date.now() - start },
        };
    }
    return {
        name: "pg.connect",
        ok: true,
        message: `connected (server ${result.serverVersion ?? "?"} in ${result.latencyMs}ms)`,
        details: {
            latencyMs: result.latencyMs,
            serverVersion: result.serverVersion,
            extensions: {
                vector: result.pgvectorVersion ?? "",
                pg_trgm: result.pgTrgmVersion ?? "",
                btree_gin: result.btreeGinVersion ?? "",
            },
        },
    };
}
async function probeEmbedding(cfg) {
    const client = buildEmbeddingClientFromConfig(cfg);
    const result = await client.probe();
    if (!result.ok) {
        return {
            name: "embedding.probe",
            ok: false,
            message: `embedding endpoint unreachable: ${result.error}`,
            details: { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl },
        };
    }
    return {
        name: "embedding.probe",
        ok: true,
        message: `embedding OK (model=${cfg.model}, dims=${result.dims}, ${result.latencyMs}ms)`,
        details: {
            provider: cfg.provider,
            model: cfg.model,
            baseUrl: cfg.baseUrl,
            dims: result.dims,
            latencyMs: result.latencyMs,
        },
    };
}
export function formatReport(report) {
    const lines = [];
    lines.push(`memory-postgres doctor: ${report.ok ? "OK" : "FAIL"}`);
    for (const p of report.probes) {
        const marker = p.ok ? "  [OK]  " : "  [FAIL]";
        lines.push(`${marker} ${p.name}: ${p.message}`);
    }
    return lines.join("\n");
}
