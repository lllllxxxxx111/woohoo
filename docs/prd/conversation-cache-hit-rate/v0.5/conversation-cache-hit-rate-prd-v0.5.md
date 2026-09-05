# Woohoo 会话缓存命中率优化 PRD：流式 usage 透传

版本：v0.5  
日期：2026-09-05  
状态：已实施  
前序版本：[v0.4 命中率监控面板](../v0.4/conversation-cache-hit-rate-prd-v0.4.md)  
适用阶段：Phase C 真实 staging 演练通过后的下一迭代候选

## 1. 背景与范围

v0.3 已知限制：流式客户端不请求 `stream_options.include_usage` 且不解析流内 usage 块，
流式记录（`operation = 'stream'` 的聊天与任务）的 usage 恒为估算值，`cached_prompt_tokens`
恒为 NULL——而本产品的对话主路径恰以流式为主，命中率面板对流式请求只能显示 `—`。

本版本范围：**流式请求透传供应商 usage**——

1. 流式请求附带 `stream_options: { include_usage: true }`（OpenAI 兼容，DeepSeek 同样支持）。
2. 解析流内 usage 块（通常为 `[DONE]` 前的最后一块），经 `StreamUsageCapture` 句柄交付调用方。
3. 流式聊天、流式任务、非流式兜底（流式回退）三条路径的 usage 全部升级为实际值（含缓存命中）。

不属于本版本：命中率趋势图、显式 `cache_control`、中间历史摘要压缩。

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 衡量口径 |
|---|------|----------|
| G1 | 流式请求请求供应商上报 usage | 请求体含 `stream_options.include_usage`，可经 `AI_STREAM_INCLUDE_USAGE=false` 一键关闭 |
| G2 | 流内 usage 块被解析并交付 | `[DONE]` 前的 usage 块写入 `StreamUsageCapture`；`usage: null` / 零值块不污染句柄 |
| G3 | 流式记录的 usage 为实际值 | `token_source = actual` 且携带 `cached_prompt_tokens`；无上报时回退估算（与旧行为一致） |
| G4 | 网关兼容性不受损 | 不识别 `stream_options` 的网关返回 400/422 时自动降级重试一次（不带该字段），流式功能不受指标采集影响 |
| G5 | 兜底路径同样透传 | `collect_completion_via_stream` 返回 `(content, usage)`；非流式响应自带 usage 优先、流式上报回退 |

### 2.2 非目标

- 不做趋势图与面板改动（v0.4 面板自动受益于流式记录补全，无需前端改动）。
- 不改变非流式请求行为（`stream_options` 仅在 `stream: true` 时附带）。

## 3. 方案与实施

### 3.1 关键设计

- **句柄而非改流类型**：`chat_stream` 返回类型保持 `Stream<Item = Result<String, _>>`，
  新增 `usage_capture: &StreamUsageCapture` 参数（`Arc<Mutex<Option<TokenUsage>>>`，take 一次）。
  全部 3 个调用方（流式聊天、流式任务、客户端内部兜底）显式创建并消费句柄，
  避免为携带 usage 重塑流类型引发的连锁改动。
- **400/422 自动降级**：兼容仅实现部分 OpenAI 协议的网关；降级仅发生一次并记录 warn 日志。
- **零值防护**：`usage` 非 object、total/completion 全为 0 的块不写入句柄，
  避免个别网关的空 usage 块把实际 usage 覆盖成 0。

### 3.2 实施改动

| 文件 | 改动 |
|------|------|
| `server/src/ai/client.rs` | `StreamUsageCapture`；`ChatRequest.stream_options`（仅流式附带）；`AiClient.stream_include_usage` + `with_stream_include_usage`；`chat_stream` 增加 capture 参数、400/422 降级重试、流内 usage 解析（含尾部残余缓冲）；`collect_completion_via_stream` 返回 `(content, usage)`；`chat()` 三处兜底合并 usage（非流式自带优先）。 |
| `server/src/ai/handlers.rs` | `ai_chat_stream`：流结束后 capture 有值则记 actual usage（含缓存命中），否则回退估算；`run_ai_task`：`finalize_task_success` 的 `AiResponse.usage` 改为 capture 结果。 |
| `server/src/main.rs` | `AiClient::new().with_stream_include_usage(config.ai_stream_include_usage)`。 |
| `server/src/config.rs` | `ai_stream_include_usage`（`AI_STREAM_INCLUDE_USAGE`，默认 `true`）。 |
| Compose ×3 / `.env.example` / `docker-deploy.md` | 透传新变量。 |

### 3.3 回滚方式

- **运行时回滚**：`AI_STREAM_INCLUDE_USAGE=false` 重启，流式请求不再附带 `stream_options`，行为回到 v0.4。
- **代码回滚**：还原本次改动；无数据库 schema 变更。

## 4. 验收标准

### 4.1 功能验收（2026-09-05 本地门禁）

- [x] `stream_options` 仅在流式请求序列化（非流式请求不带该字段）——`chat_request_serializes_stream_options_only_when_set`。
- [x] 句柄语义：未上报 None、set 后首次 take Some、二次 take None——`stream_usage_capture_take_semantics`。
- [x] usage 块不产出内容且写入句柄（含 DeepSeek/OpenAI 缓存字段）——`stream_usage_chunk_sets_capture_without_content`；`"usage": null` 空块不捕获——`stream_null_usage_chunk_is_ignored`。
- [x] `cargo test` 298 passed（294 + 4 新增）；`cargo fmt --check` 通过；clippy 127 → 127 零新增（含编译期 unused_assignments 及时清理）。
- [x] 前端无代码改动（v0.4 面板经既有类型与 `token_source` 展示自动受益）。

### 4.2 效果验收（staging / 内部试用期间采集）

| 指标 | 目标 | 数据来源 |
|------|------|----------|
| 流式记录 `token_source` 分布 | `actual` 占比显著上升（支持 include_usage 的供应商） | `ai_usage_events` |
| 流式会话命中率 | v0.4 面板中流式为主会话由 `—` 变为有值 | Usage Dashboard by_conversation |
| 降级重试日志 | 仅在不兼容网关出现，且流式功能不受损 | `stream_options.include_usage 请求被拒绝` warn 日志 |

## 5. 后续方向（v0.6 备选）

| 方向 | 说明 |
|------|------|
| 命中率趋势图 | 用 series 中已就绪的 `cachedPromptTokens / cachedTokenRecords` 画时间趋势曲线。 |
| 显式 `cache_control` | 为 OpenAI-compatible 网关或 Anthropic API 添加 ephemeral 缓存标记。 |
| 中间历史摘要压缩 | 被裁剪的中间段用低成本模型生成摘要，替换为一条消息插在前缀之后。 |

## 6. 关联资料

- [v0.4 命中率监控面板 PRD](../v0.4/conversation-cache-hit-rate-prd-v0.4.md)
- [v0.3 命中率可观测 PRD](../v0.3/conversation-cache-hit-rate-prd-v0.3.md)
- [封闭 Beta 稳定化 PRD v1.2](../../closed-beta-stabilization/v1.2/closed-beta-stabilization-prd-v1.2.md)
- [Docker 部署说明](../../../docker-deploy.md)
- 实施代码：`server/src/ai/client.rs`、`server/src/ai/handlers.rs`、`server/src/config.rs`
