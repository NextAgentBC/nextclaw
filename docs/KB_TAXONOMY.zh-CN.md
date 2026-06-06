# 知识库（KB）文件系统式分类

[English](KB_TAXONOMY.md) · **简体中文**

> bot 见到的每一个文件——无论是通过 Telegram 上传、由老师用 `scp`
> 放进来，还是将来由某个 Web 上传界面送入——都存放在同一个根目录下，
> 遵循同一套规则。这些规则是机械式的，而非由 LLM 决定，因此 bot 的存储
> 始终保持整洁，我们无需指望 agent 去“自觉守规矩”。

## 根目录

```
/home/ubuntu/.openclaw/kb/         ← OPENCLAW_KB_ROOT env var (default)
```

整棵树都位于同一个用户拥有的目录下。备份非常简单（`pg_dump` 加上对该
目录做一次 `tar`，即可得到 agent 记忆 + 原始素材的完整快照）。

## 顶层布局

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

## 命名约定

### 文件名

```
<base-name>__<doc-id>__v<N>.<ext>
```

- **base-name**：原始文件名（经过 slug 化处理：转小写、空格 → `-`、
  去掉中日韩标点、保留 ASCII 与中日韩字符）。
- **doc-id**：跨版本保持稳定的标识符。默认取 base-name 的 slug，
  可通过 `--doc-id` 参数覆盖。用作 `anchor_kb_doc` 的取值。
- **vN**：版本号。摄入工具通过统计同一文件夹中具有相同 `doc-id` 的
  现有文件数量来计算它；首次上传为 `v1`。

示例：
```
courses/ai-course/week1/00-overview__ai-course-week1-00__v1.md
courses/ai-course/week1/00-overview__ai-course-week1-00__v2.md   ← later upload
```

旧版本会保留在磁盘上以备审计；它们在 `semantic.chunks` 中的记忆块
（chunk）会带上 `superseded_by`，指向更新的记忆块，因此召回时永远
不会返回它们。

### 目录名

- 群组 / 用户 / 学生文件夹：一律为 `tg-<numeric-id>`。这个数字 id
  是稳定的；人类可读的别名存放在 `_meta/aliases.json` 中，这样在
  Telegram 里重命名群组不会破坏路径。
- 课程文件夹：课程名称的 `<slug>`（转小写、空格 → `-`、保留中日韩字符）。
- 主题文件夹：同样的 slug 规则。

## 路由规则（机械式）

给定一次上传 `(file, sender_user_id, chat_id, chat_type, caption)`：

1. **若 `chat_type` 为私聊（DM）：**
   - 若发送者是 bot 拥有者（与 `commands.ownerAllowFrom` 匹配）：
     - 若 caption 含 `#course <course-id>` → `courses/<course-id>/inbox/`
     - 否则 → `inbox/<date>/`（老师稍后审阅）
   - 若发送者是已知学生：
     - 若 caption 含 `#share` → `students/tg-<user_id>/shared-with-teacher/`
     - 否则 → `students/tg-<user_id>/inbox/`
   - 其他情况（未知发送者）：`_meta/purgatory/<date>/`（需审阅）

2. **若 `chat_type` 为群组 / 超级群组：**
   - 若发送者是 bot 拥有者：
     - 若 caption 含 `#teacher-only` → `groups/tg-<chat_id>/teacher-only/`
     - 否则 → `groups/tg-<chat_id>/shared/`
   - 若发送者是学生：
     - 若 caption 含 `#share` → `groups/tg-<chat_id>/shared/`
     - 默认 → `students/tg-<user_id>/inbox/`（即便是在群组里上传，
       也视为个人作业；分享需主动选择加入）

3. **Caption 提示（在上述基础上叠加）：**
   - `#week<N>` → 放入 `week<N>` 子文件夹
   - `#homework` → 放入 `homework/` 子文件夹
   - `#topic <slug>` → 放入 `<slug>/` 子文件夹
   - `#doc-id <slug>` → 覆盖自动推导出的 doc-id
   - `#version <N>` → 手动覆盖版本号（否则自动递增）

## 摄入资格

并非每个上传的文件都会变成记忆块（chunk）。由摄入工具决定：

| 格式 | 行为 |
|---|---|
| `.md / .markdown` | 解析 + 切块 + 嵌入 + 插入 |
| `.txt` | 按 markdown 处理，但不做标题切分 |
| `.pdf` | （Phase B++.2）pdf-parse → 切块 + 嵌入 + 插入 |
| `.docx` | （Phase B++.2）mammoth → markdown → 切块 + 插入 |
| `.csv`（含 Q、A 两列） | （Phase B++.2）按行 → cache.qa 预填充 + 切块 |
| `.html / .htm` | （Phase B++.2）html-to-text → 切块 + 插入 |
| `.png / .jpg / .heic` | 仅存储；不摄入（直到支持多模态） |
| `.mp3 / .ogg / .wav / .m4a` | （后续）credbroker ASR → 切块 |
| `.mp4 / .mov` | 仅存储 |
| 其他任何类型 | 仅存储；在 `_meta/upload-log.jsonl` 中标记为 “unsupported” |

## 锚点映射

每个由 KB 文件写入的记忆块（chunk）都携带以下锚点（来自
`semantic.chunk_indexes` 中的 `anchor_kind=value`）：

| 锚点种类 | 取值 |
|---|---|
| `anchor_kb_doc` | doc-id（跨版本稳定） |
| `anchor_kb_version` | `v<N>` |
| `anchor_kb_path` | 在 `kb/` 下的相对路径，用于可追溯性 |
| `anchor_sender_id` | `tg-<uploader_user_id>`（仅用于学生上传；老师上传保持发送者匿名，以便全局可发现） |
| `anchor_chat_id` | 若上传为群组范围，则为 `tg-<chat_id>` |
| `anchor_visibility` | 按路由结果取 `public` / `private` / `teacher-only` |
| `anchor_topic` | 来自 caption 提示，或文件的首个标题 |
| `anchor_category` | 由 Stage 0 分类器推导 |

这意味着 Phase B 构建的同一个 `viewer-scope` 过滤器可以零成本地作用于
KB 内容：即便某个学生摄入了同一棵 `kb/students/tg-X/homework/` 树，
他也看不到另一个学生的作业。

## 审计日志

每次摄入都会向 `_meta/upload-log.jsonl` 追加一行 JSON：

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

这份日志是“哪些文件在哪里”以及“谁在何时上传了什么”的唯一可信来源。
仪表盘的 `/kb` 视图就从它读取数据。

## 垃圾清理 / 轮转策略

- `inbox/` 中超过 30 天的条目移入 `_meta/purgatory/`
- `_meta/purgatory/` 中超过 90 天的条目会被删除（PG 中的记忆块
  保留 `superseded_by` 链——磁盘空间释放，记忆完好无损）
- `courses/*/` 与 `groups/*/shared/` 永不自动删除；仅可通过
  `nextclaw kb remove <doc-id>` 手动删除
- `students/*/inbox/` 按学生维度、需主动选择加入的清理（学生的数据，
  由学生自己决定）
