# 实测（Live tests）

[English](LIVE_TESTS.md) · **简体中文**

`test/` 目录下的大多数文件都通过 `OPENCLAW_LIVE_TEST=1` 进行门控，因为
它们需要一个正在运行的 Postgres + 嵌入服务端点，而我们不希望在缺少这些
依赖的环境中导致 CI 失败。

## 前置条件

```bash
cd dev/ && docker compose up -d            # Postgres on 127.0.0.1:55432
ollama serve & ollama pull nomic-embed-text   # Embedding endpoint
```

## 运行

在 OpenClaw 仓库根目录下运行（如果扩展目录自带测试运行器，也可在该目录内运行）：

```bash
export OPENCLAW_LIVE_TEST=1
export NEXTCLAW_DB_URL='postgres://nextclaw:nextclaw@127.0.0.1:55432/nextclaw'
export NEXTCLAW_EMBED_URL='http://127.0.0.1:11434'
export NEXTCLAW_EMBED_MODEL='nomic-embed-text'

# All live tests
pnpm test extensions/memory-postgres/test/

# Or a specific file
pnpm test extensions/memory-postgres/test/recall.live.test.ts
```

若未设置 `OPENCLAW_LIVE_TEST=1`，所有 `*.live.test.ts` 文件都会静默跳过。

## 各项实测的覆盖范围

| 文件 | 断言内容 |
|---|---|
| `e2e.live.test.ts` | 完整的摄入 → 召回往返流程；`agent_id` 隔离；多键索引派生 |
| `pipeline.live.test.ts` | Stage 0–6 摄入流水线行为：垃圾过滤、去重、sidecar、多键写入 |
| `recall.live.test.ts` | 全部 8 条路由正确触发；MMR 重排多样性；cache.recall TTL |
| `structured.live.test.ts` | 提取器对账（实体、事件、指标、偏好） |
| `compactor.live.test.ts` | 90 天冷数据 gist 合并 |
| `tuning.live.test.ts` | 自调优分析器按计划周期触发 |
| `dashboard.live.test.ts` | HTTP 端点返回预期结构；SSE 投递审计事件 |
| `qwen3.live.test.ts` | 嵌入服务端点可达性 + 响应结构 |

## 测试隔离

每个测试都会创建唯一的 `source` 前缀，并在该前缀下植入数据块（chunks）。
清理工作在 `afterEach` 中通过 `DELETE FROM semantic.chunks WHERE
source LIKE '<prefix>:%'` 执行，并级联清理 `cache.*` 和 `audit.*` 行。

如果某个测试中途失败并残留了状态，请运行：

```bash
docker exec -e PGPASSWORD=nextclaw nextclaw-pg psql -U nextclaw -d nextclaw -c "
DELETE FROM semantic.chunks WHERE source LIKE 'test-%';
DELETE FROM cache.recall;
DELETE FROM cache.intent;
"
```

## 新增一项实测

1. 将其命名为 `*.live.test.ts`，以便在未设置环境变量标志时自动跳过
2. 为每个测试使用唯一的 `source` 前缀（类似 `secrets.token_hex(4)` 的风格）
3. 在 `afterEach` 中清理
4. 不要在测试文件之间共享状态；每个文件各自拥有其数据

## CI 注意事项

标准 CI 流水线**不会**运行这些测试——它们所需的基础设施在每次运行时
启动的成本很高。在提交涉及以下内容的 PR 之前，请先在本地运行它们：

- `src/storage/schema/*.sql`（任何 schema 变更）
- `src/recall/router.ts` 或 `src/recall/routes.ts`
- `src/ingest/pipeline.ts`
- `transcript-watcher` / `git-watcher` / `shadow-comparator` worker
- `src/dashboard/server.ts` 中任何影响 API 端点的内容
