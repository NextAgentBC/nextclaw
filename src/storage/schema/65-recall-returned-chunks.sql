-- audit.recall_decisions.returned_chunk_ids — the chunks a recall actually
-- returned. Lets a later memory_get (citation follow-up) credit the recall that
-- surfaced the chunk with a relevance signal (P0#2). Nullable array; older rows
-- stay NULL and are simply never matched.
ALTER TABLE audit.recall_decisions ADD COLUMN IF NOT EXISTS returned_chunk_ids UUID[];
