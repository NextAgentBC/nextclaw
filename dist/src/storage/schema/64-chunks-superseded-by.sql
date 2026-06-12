-- semantic.chunks.superseded_by — points at the later chunk whose fact replaced
-- this one (set by reconcile when a preference value changes). Recall
-- down-weights superseded chunks so the current truth wins, while the old chunk
-- stays recallable for audit / "what did I used to think". Nullable; plain UUID
-- (no FK) so a hard-delete of the newer chunk can't cascade-block the older one.
ALTER TABLE semantic.chunks ADD COLUMN IF NOT EXISTS superseded_by UUID;
