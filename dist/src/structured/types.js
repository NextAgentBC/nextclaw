/**
 * Shared types for the structured extractor + reconcile + API layer.
 *
 * Each extractor produces zero or more candidate rows from a piece of text
 * plus deterministic signals (tool call metadata, sidecar JSON, regex hits).
 * The reconcile layer dedups/supersedes against existing structured.* rows.
 * The API layer exposes typed read operations to the rest of the plugin
 * (and, via the SDK barrel, to other plugins).
 */
export const emptyResult = (extractorVersion) => ({
    entities: [],
    relations: [],
    events: [],
    preferences: [],
    metrics: [],
    extractorVersion,
});
