/**
 * SDK re-export for the structured memory API.
 *
 * Phase 2 publishes the API + types here so other plugins (Phase 6 wiki/honcho
 * integration, Phase 7 dashboard) can consume typed reads without reaching into
 * memory-postgres internals. Phase 4 will export this through OpenClaw's
 * plugin-sdk surface as `memory-postgres-structured`.
 */
export { StructuredMemoryAPI, } from "../structured/api.js";
export { extractAll, EXTRACTOR_VERSION } from "../structured/extractors.js";
export { reconcile } from "../structured/reconcile.js";
