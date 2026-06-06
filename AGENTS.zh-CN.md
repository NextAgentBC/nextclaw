# nextclaw — 贡献指南

[English](AGENTS.md) · **简体中文**

基于 Postgres + pgvector 的 OpenClaw 记忆插件，用于填充 `plugins.slots.memory` 插槽（slot）。

## 适用范围

- 一旦接入该插槽，即替换 `memory-core`（内置的 SQLite 后端）
- 4 层记忆：T0 进程内 / T1 PG UNLOGGED 热缓存 / T2 主存 / T3 冷存摘要（gist）
- 多键索引（multi-key indexing，"新华字典"式）：每个记忆块（chunk）都按概念标签、实体引用、锚点（cwd/branch/PR/file）、时间桶、指标/偏好键，以及 6+1 分类体系进行索引
- 摄入（ingest）流水线：确定性（deterministic）+ sidecar JSON + 缓存，LLM 仅作为兜底残差
- 召回（recall）：逐层游走 T0→T1→T2→T3，多路并行（即便缺少高精度锚点也不跳过）
- 对每个事件进行记忆操作打分（scoring）（ingest_score / recall_score）
- 自调优循环（self-tuning loop）（每日 / 每周 / 每月生成提案）
- 通过 PG LISTEN/NOTIFY 驱动仪表盘
- 强制的按 agent 隔离（per-agent isolation）记忆命名空间（namespace）（`agent_id` 列贯穿每条召回路径）
- 动作敏感型承诺：agent 可能据以采取行动的指令会被打上标记（`safe_to_act` / `requires_confirmation` / `authority` / 有效期），并在召回时以 ⚠ 标出，从而避免一句随口之言触发某个动作

## 目录结构

| Path | 职责 |
|---|---|
| `src/storage/` | pg.Pool、schema DDL、迁移（migration） |
| `src/embedding/` | OpenAI 兼容的嵌入客户端 + chat 客户端（用于影子对比器） |
| `src/ingest/` | Stage 0–6 流水线 + sidecar 提示词构建器 |
| `src/recall/` | 逐层游走 + 多路并行实现 + 意图识别 + 合并 |
| `src/workers/` | context-primer、spreading-activator、compactor、feedback、scoring、tuning、git-watcher、transcript-watcher、shadow-comparator |
| `src/cache/` | CacheBackend 抽象 + PG UNLOGGED 实现 |
| `src/structured/` | 实体 / 事件 / 指标 / 偏好 / 承诺抽取器 + 调和（reconcile）+ 分类器（另含 `commitments.ts` 召回侧读取器） |
| `src/sdk/` | StructuredMemoryAPI 公开导出 |
| `src/dashboard/` | HTTP 服务器 + SPA 资源 + bot-stats |
| `src/cli/` | tail（router-explain、audit、stats 等位于 dashboard 中） |
| `skills/` | 随插件一同发布的 OpenClaw 运维 skill（目前为 `openclaw-selfcare` —— 对 openclaw 及本插件进行安全的自升级） |

## 规则

- 所有 SQL 一律经由 `src/storage/pool.ts` 中的 `pg.Pool`。切勿内嵌连接字符串。
- schema（表结构）变更归属于 `src/storage/schema/*.sql` + `src/storage/migrate.ts`。切勿通过临时 DDL 改动。
- 每个审计行（audit row）都携带 `score`（摄入）或 `score + relevance_estimate`（召回）。
- 打分计算位于 `src/scoring.ts`。不要把公式内联到路由代码中。
- 优先采用确定性信号（Stage 0），其次 sidecar，最后才是 LLM。新功能必须契合这一层级顺序。
- 嵌入适配器（embedding adapter）的替换必须可用；切勿在 config 之外硬编码 model id。
- 缓存后端（cache backend）的替换必须可用；切勿绕过 `CacheBackend` 接口。
- 仪表盘端点默认仅服务 **localhost**。任何超出 `127.0.0.1` 的访问都需通过 `dashboard.tokenEnv` 显式提供 token。
- 调优的自动应用仅对 `safe_auto` 提案生效；其余一切均以 `status='pending'` 写入 `audit.tuning_proposals`。

## 测试

- 单元测试：各模块对应 `src/**/*.test.ts`
- 在线（Live）测试：`test/*.live.test.ts` 需要 `OPENCLAW_LIVE_TEST=1` 以及可访问的 Postgres + 嵌入端点
- 运行单元测试：`pnpm test`

## 依赖

- `pg`（node-postgres）—— 支持仪表盘所需的 LISTEN/NOTIFY
- `pgvector` —— 面向 `pg` 的 pgvector 类型绑定
- `undici` —— 用于面向 `api.telegram.org` 的 IPv4 优先 dispatcher 的 HTTP 客户端（`src/moderator/telegram-api.ts`）。直接声明依赖，而非依赖其传递引入，从而确保 OpenClaw 依赖树的变动不会令其凭空消失。

## 跨扩展契约（cross-extension contract）

- 自带嵌入能力：内部的 `EmbeddingClient`（manager-runtime → OpenAI 兼容 / Ollama 端点）自行完成嵌入。nextclaw 是嵌入的**消费方**，而非宿主提供方 —— 它**不**注册 `MemoryEmbeddingProviderAdapter`，也不声明任何 `contracts.embeddingProviders`
- 实现来自 `openclaw/plugin-sdk/memory-core-host-engine-storage` 的 `MemorySearchManager`
- 对外暴露 `StructuredMemoryAPI` 汇总入口，供希望以 SQL 形态访问的插件使用
