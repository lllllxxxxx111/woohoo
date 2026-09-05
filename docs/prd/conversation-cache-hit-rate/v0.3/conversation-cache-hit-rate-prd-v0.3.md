# Woohoo 会话缓存命中率优化 PRD：命中率可观测（指标采集层）

版本：v0.3  
日期：2026-09-05  
状态：已实施，待 staging 采集  
前序版本：[v0.2 参数运行时可调与截断开关](../v0.2/conversation-cache-hit-rate-prd-v0.2.md)  
适用阶段：Phase C 真实 staging 演练通过后的下一迭代候选

## 1. 背景与范围

v0.1 / v0.2 已落地前缀稳定截断与参数运行时可调，但效果验收只能依赖 staging 期间手工观测：
供应商上报的缓存命中 tokens 没有解析入库，服务端也没有对「相邻请求前缀稳定性」的度量。
无法回答「截断策略到底带来多少缓存命中」这一核心问题。

本版本范围：**命中率数据采集层**——

1. 解析并持久化供应商上报的缓存命中 prompt tokens（`ai_usage_events.cached_prompt_tokens`）。
2. 服务端探针计算同会话相邻请求的共享前缀占比并持久化（`ai_usage_events.prompt_prefix_hit_ratio`）。
3. Usage summary API 透出缓存命中聚合（totals / series / by_conversation / 各 breakdown 命中率）。

不属于本版本：前端监控面板展示（v0.4 候选）、显式 `cache_control` 标记、中间历史摘要压缩、指标运行期热更新。

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 衡量口径 |
|---|------|----------|
| G1 | 供应商上报的缓存命中 prompt tokens 被解析入库 | 兼容 OpenAI `prompt_tokens_details.cached_tokens` 与 DeepSeek `prompt_cache_hit_tokens`；未上报或为 0 时记 NULL（「无数据」≠「命中率为 0」），有单测覆盖 |
| G2 | 服务端探针记录同会话相邻请求共享前缀占比并入库 | 占比 = 共享前缀字符数 / 本次请求序列化字符数（与供应商 cached_tokens / prompt_tokens 同口径），有单测覆盖 |
| G3 | Usage summary API 透出缓存命中聚合 | totals / series 增加 `cached_prompt_tokens` + `cached_token_records`；新增 `by_conversation` 维度（top 10，含会话标题回退「已删除会话 / 非会话请求」）；各 breakdown 增加 `cache_hit_ratio`（无数据时 null） |
| G4 | 迁移幂等且不破坏 legacy 路径 | 035 缺表旧库延后不阻塞启动；`ensure_ai_usage_schema` 与 agent-FK 重建路径保留缓存列 |

### 2.2 非目标

- 不做前端展示（面板留待 v0.4，本版本先建立数据管道）。
- 不改变请求组装行为（截断策略与 v0.2 完全一致）。
- 探针数据不保证跨重启留存（纯内存、有界淘汰，是采样观测而非审计数据）。

## 3. 方案与实施

### 3.1 探针口径（G2 关键决策）

`prompt_prefix_hit_ratio` 的分母取**本次请求**序列化长度，而非两次请求中较短的一侧：

- 与供应商 `cached_tokens / prompt_tokens` 口径一致，服务端探针值可与供应商上报值直接对照校验；
- 若分母取较短一侧，稳定追加会话恒为 1.0，失去度量意义；
- 新请求是旧请求前缀的收缩场景下占比为 1.0，符合「全部命中」的供应商语义。

探针实现为进程内 `Mutex<ProbeStore>`：每会话记录上一次请求的序列化文本，单请求超 512KiB 或会话数超 256 时按插入序淘汰/退出采样，防止内存无限增长。序列化包含 system prompt 与末尾 runtime 快照——相邻请求的共享前缀自然终止于第一条不同的消息，无需单独排除末尾快照。

测量时机：在 `prepare_chat_request` 组装完消息后恰好测量一次并更新该会话基线——即使后续 AI 调用失败也保留本次占比（度量的是「相邻请求组装序列」的稳定性）；prepare 之前就失败的路径（上下文解析、任务调度）没有测量值，记 NULL。

### 3.2 实施改动

| 文件 | 改动 |
|------|------|
| `server/src/ai/cache_probe.rs`（新增） | 探针与 8 个单测。 |
| `server/src/ai/client.rs` | `TokenUsage.cached_prompt_tokens`；`parse_token_usage` 兼容 OpenAI / DeepSeek 两种上报字段，0 值视为未上报；+3 单测。 |
| `server/src/ai/usage.rs` | `UsageNumbers` / `RecordAiUsageInput` / `AiUsageRecord` 增加缓存字段；totals / series 聚合 `cached_prompt_tokens` 与 `cached_token_records`；新增 `by_conversation` breakdown；breakdown 项增加 `prompt_tokens` 与 `cache_hit_ratio`；`cache_hit_ratio` 纯函数 +3 单测。 |
| `server/src/ai/handlers/chat_core.rs` | `prepare_chat_request` 改收 `&AppState`，按 v0.2 策略组装消息后恰好测量一次探针（含 v0.2 的 `ChatHistoryPolicy` 改造）。 |
| `server/src/ai/handlers.rs` / `shared.rs` | usage 记录全链路透传 `cached_prompt_tokens` 与 `prompt_prefix_hit_ratio`（失败/无 prepared 场景记 NULL）。 |
| `server/src/db.rs` | 注册 035；`apply_migration_035_ai_usage_cache_metrics` 守卫式逐列 ALTER（缺表延后、已记录跳过、缺列才加）；`ensure_ai_usage_schema` 补列数组加入两列；agent-FK 重建路径的建表带上新列，旧快照无列时保持 NULL 拷贝。 |
| `server/migrations/035_ai_usage_cache_metrics.sql`（新增） | `ai_usage_events` 加 `cached_prompt_tokens INTEGER`、`prompt_prefix_hit_ratio REAL`（均可空）。 |
| `server/src/config.rs` | （v0.2 部分）`AI_CHAT_HISTORY_*` 三参数与 `test_config()`。 |

### 3.3 已知限制

- **流式请求无供应商缓存命中数据**：流式客户端未请求 `stream_options.include_usage` 且未解析流内 usage 块，流式记录的 usage 为估算值，`cached_prompt_tokens` 恒为 NULL；服务端探针占比不受影响。流式 usage 透传列为 v0.4 候选。
- 探针基线随重启清零，且超长请求（>512KiB 序列化）退出采样，属采样观测而非全量审计。

### 3.4 回滚方式

- **代码回滚**：还原本次改动即可。035 只新增可空列，旧代码忽略之，无需删列迁移。
- **探针回滚**：探针为纯内存副作用，不影响请求行为；如需彻底移除，还原 `chat_core.rs` 的测量调用即可。
- **数据保留**：新列保留历史采集值，重发版后继续累积。

## 4. 验收标准

### 4.1 功能验收（2026-09-05 本地门禁）

- [x] 探针：首轮 None、相同请求 1.0、追加会话按旧/新长度比、system 变化骤降、会话独立、超长退出采样、容量淘汰最旧、空输入 None —— `cache_probe` 8 个单测。
- [x] 供应商字段解析：OpenAI details、DeepSeek 直出字段、未上报/0 值为 None —— `parse_token_usage` 3 个单测。
- [x] 聚合口径：有上报数据且 prompt>0 才给出比值，否则 None —— `cache_hit_ratio` 3 个单测。
- [x] v0.2 截断策略回归：6 个 `chat_history_tests` 全部通过（默认/关闭/自定义窗口/零前缀/from_config）。
- [x] legacy 兼容：缺 `ai_usage_events` 的夹具迁移不再失败；重建路径保留缓存列（`ai_usage_repair_rebuilds_legacy_agent_foreign_key_with_trigger_source` 回归通过）；版本列表断言更新。
- [x] `cargo test` 294 passed；`cargo fmt --check` 通过；clippy 127 → 127（零新增，基线经 stash 对比确认）。
- [x] 前端无代码改动（summary API 为纯增量字段，TS 类型未消费前不感知）。

### 4.2 效果验收（staging / 内部试用期间采集）

本版本不设硬性命中率目标——先通过以下口径建立基线，再决定 v0.4 优化方向：

| 指标 | 来源 |
|------|------|
| 会话请求 `cached_prompt_tokens / prompt_tokens`（供应商口径） | `ai_usage_events` 聚合 / by_conversation |
| 服务端探针 `prompt_prefix_hit_ratio` 分布（前缀稳定性） | `ai_usage_events.prompt_prefix_hit_ratio` |
| 截断开关演练对照：`AI_CHAT_HISTORY_TRUNCATION_ENABLED=false` 前后探针占比差异 | 演练记录 + 请求日志 |
| 两者偏差：探针值显著高于供应商命中值时，说明该供应商缓存粒度/计费未对齐前缀 | staging 对比查询 |

## 5. 后续方向（v0.4 备选）

| 方向 | 说明 |
|------|------|
| 命中率监控面板 | Usage Dashboard 呈现 by_conversation 命中率与趋势（数据已由本版本就绪）。 |
| 流式 usage 透传 | 流式客户端请求 `stream_options.include_usage` 并解析流内 usage 块，补齐流式记录的供应商命中 tokens。 |
| 显式 `cache_control` | 为 OpenAI-compatible 网关或 Anthropic API 添加 ephemeral 缓存标记，显式声明可缓存前缀边界。 |
| 中间历史摘要压缩 | 被裁剪的中间段用低成本模型生成摘要，替换为一条消息插在前缀之后。 |

## 6. 关联资料

- [v0.2 参数运行时可调与截断开关 PRD](../v0.2/conversation-cache-hit-rate-prd-v0.2.md)
- [v0.1 会话缓存命中率优化 PRD](../v0.1/conversation-cache-hit-rate-prd-v0.1.md)
- [封闭 Beta 稳定化 PRD v1.2](../../closed-beta-stabilization/v1.2/closed-beta-stabilization-prd-v1.2.md)
- [Docker 部署说明](../../../docker-deploy.md)
- 实施代码：`server/src/ai/cache_probe.rs`、`server/src/ai/usage.rs`、`server/src/ai/client.rs`、`server/src/db.rs`
