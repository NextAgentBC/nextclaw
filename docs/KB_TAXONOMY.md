# KB filesystem taxonomy

**English** · [简体中文](KB_TAXONOMY.zh-CN.md)

> Every file the bot ever sees — whether uploaded via Telegram, dropped
> in by the teacher with `scp`, or fed in by a future web upload UI —
> lives under one root directory with one set of rules. The rules are
> mechanical, not LLM-decided, so the bot's storage stays tidy without
> us trusting the agent to "be neat."

## Root

```
/home/ubuntu/.openclaw/kb/         ← OPENCLAW_KB_ROOT env var (default)
```

A single tree under one user-owned dir. Easy to back up (`pg_dump` + a
single `tar` of this dir is a full snapshot of agent memory + raw
sources).

## Top-level layout

```
kb/
├── _meta/                         meta / index files (NOT ingested)
│   ├── upload-log.jsonl           append-only audit log of every intake
│   ├── aliases.json               numeric-id → human-name map
│   │                              (e.g. tg-1001234567890 → "5年级数学群")
│   ├── versions.json              { "<doc-id>": { "current": "v3", "history": [...] } }
│   └── purgatory/                 files quarantined for review
│
├── inbox/                         freshly-received, not yet classified
│   └── 2026-05-16/                date-bucketed, auto-rotated
│       └── <original-filename>
│
├── courses/                       teacher-uploaded curriculum (global scope)
│   └── <course-id>/
│       ├── _info.md               course description (manually written)
│       └── <topic>/               e.g. "week1", "fractions", "essay-writing"
│           ├── <file>
│           └── ...
│
├── groups/                        per-Telegram-group shared materials
│   └── tg-<chat_id>/              (chat-id is numeric, negative for groups)
│       ├── _info.md               who's in this group, what's the focus
│       ├── shared/                visible to everyone in the group
│       │   └── <file>
│       └── teacher-only/          visible only to the teacher viewer
│           └── <file>
│
└── students/                      per-student private files
    └── tg-<user_id>/              (telegram user_id)
        ├── homework/
        │   └── YYYY-MM-DD__<title>.<ext>
        ├── notes/
        └── shared-with-teacher/   student opts to share with teacher only
```

## Naming convention

### File names

```
<base-name>__<doc-id>__v<N>.<ext>
```

- **base-name**: the original filename (slugged: lowercase, spaces → `-`,
  drop CJK punctuation, keep ASCII + CJK chars).
- **doc-id**: stable identifier across versions. Defaults to the slug of
  the base-name; can be overridden via `--doc-id` flag. Used as the
  `anchor_kb_doc` value.
- **vN**: version. The intake tool computes this by counting existing
  files with the same `doc-id` in the same folder; first upload is `v1`.

Example:
```
courses/ai-course/week1/00-overview__ai-course-week1-00__v1.md
courses/ai-course/week1/00-overview__ai-course-week1-00__v2.md   ← later upload
```

Old versions stay on disk for audit; their chunks in `semantic.chunks`
get `superseded_by` pointing at the newer chunks so recall never
returns them.

### Directory names

- Group / user / student folders: `tg-<numeric-id>` always. The numeric
  id is stable; human-readable aliases live in `_meta/aliases.json` so
  renaming a group in Telegram doesn't break paths.
- Course folders: `<slug>` of the course name (lowercase, spaces → `-`,
  CJK kept).
- Topic folders: same slug rule.

## Routing rules (mechanical)

Given an upload `(file, sender_user_id, chat_id, chat_type, caption)`:

1. **If `chat_type` is private (DM):**
   - If sender is the bot owner (`commands.ownerAllowFrom` matches):
     - If caption has `#course <course-id>` → `courses/<course-id>/inbox/`
     - Else → `inbox/<date>/` (teacher reviews later)
   - If sender is a known student:
     - If caption has `#share` → `students/tg-<user_id>/shared-with-teacher/`
     - Else → `students/tg-<user_id>/inbox/`
   - Otherwise (unknown sender): `_meta/purgatory/<date>/` (review required)

2. **If `chat_type` is group / supergroup:**
   - If sender is the bot owner:
     - If caption has `#teacher-only` → `groups/tg-<chat_id>/teacher-only/`
     - Else → `groups/tg-<chat_id>/shared/`
   - If sender is a student:
     - If caption has `#share` → `groups/tg-<chat_id>/shared/`
     - Default → `students/tg-<user_id>/inbox/` (treat as personal
       homework even though uploaded in a group; opt-in to share)

3. **Caption hints (in addition to the above):**
   - `#week<N>` → puts into `week<N>` subfolder
   - `#homework` → puts into `homework/` subfolder
   - `#topic <slug>` → puts into `<slug>/` subfolder
   - `#doc-id <slug>` → overrides the auto-derived doc-id
   - `#version <N>` → manual version override (else auto-incremented)

## Ingest eligibility

Not every uploaded file becomes a chunk. The intake tool decides:

| Format | Behavior |
|---|---|
| `.md / .markdown` | parse + chunk + embed + insert |
| `.txt` | treat like markdown but no heading splits |
| `.pdf` | (Phase B++.2) pdf-parse → chunk + embed + insert |
| `.docx` | (Phase B++.2) mammoth → markdown → chunk + insert |
| `.csv` (with Q,A columns) | (Phase B++.2) row → cache.qa pre-seed + chunk |
| `.html / .htm` | (Phase B++.2) html-to-text → chunk + insert |
| `.png / .jpg / .heic` | store only; no ingest (until multimodal) |
| `.mp3 / .ogg / .wav / .m4a` | (later) credbroker ASR → chunk |
| `.mp4 / .mov` | store only |
| anything else | store only; flag as "unsupported" in `_meta/upload-log.jsonl` |

## Anchor mapping

Every chunk written from a KB file carries these anchors (from
`anchor_kind=value` in `semantic.chunk_indexes`):

| Anchor kind | Value |
|---|---|
| `anchor_kb_doc` | the doc-id (stable across versions) |
| `anchor_kb_version` | `v<N>` |
| `anchor_kb_path` | the rel path under `kb/` for traceability |
| `anchor_sender_id` | `tg-<uploader_user_id>` (for student uploads only; teacher uploads stay sender-anonymous for global discoverability) |
| `anchor_chat_id` | `tg-<chat_id>` if upload is group-scoped |
| `anchor_visibility` | `public` / `private` / `teacher-only` per routing |
| `anchor_topic` | from caption hint, or first heading of the file |
| `anchor_category` | derived by Stage 0 categorizer |

This means the same `viewer-scope` filter Phase B built works on KB
content for free: students can't see another student's homework even
if they ingest the same `kb/students/tg-X/homework/` tree.

## Audit log

Every intake appends one JSON line to `_meta/upload-log.jsonl`:

```json
{
  "ts": "2026-05-16T19:36:00Z",
  "source": "telegram",
  "sender_user_id": "8064984663",
  "chat_id": "-1001234567890",
  "chat_type": "supergroup",
  "caption": "#share #week3 homework explanation",
  "original_filename": "homework-week3.pdf",
  "saved_path": "groups/tg-1001234567890/shared/homework-week3__week3-homework__v1.pdf",
  "format": "pdf",
  "doc_id": "week3-homework",
  "version": "v1",
  "chunks_written": 0,
  "chunks_status": "pending-pdf-support",
  "errors": []
}
```

This log is the source of truth for "what files are where" and "who
uploaded what when." The dashboard `/kb` view reads from it.

## Garbage / rotation policy

- `inbox/` entries older than 30 days move to `_meta/purgatory/`
- `_meta/purgatory/` entries older than 90 days are deleted (chunks
  in PG keep `superseded_by` chain — disk freed, memory intact)
- `courses/*/` and `groups/*/shared/` are never auto-deleted; only
  manually via `nextclaw kb remove <doc-id>`
- `students/*/inbox/` is per-student, opt-in cleanup (student's data,
  student decides)
