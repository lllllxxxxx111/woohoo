# Woohoo 会话缓存命中率优化 PRD

版本：v0.1  
日期：2026-08-25  
状态：功能验收已完成，效果指标待 staging / 内部试用采集  
关联基线：[封闭 Beta 稳定化 PRD v1.2](../../closed-beta-stabilization/v1.2/closed-beta-stabilization-prd-v1.2.md)  
适用阶段：Phase C 真实 staging 演练通过后的下一迭代候选

## 1. 背景与问题

当前 AI 对话请求在 `server/src/ai/handlers/chat_core.rs` 中组装上下文，存在两个影响供应商 prompt cache 命中率的问题：

1. **system prompt 每次变化**。`build_execution_prompt()` 生成的实时执行快照（项目进度、角色计数、任务队列、重试提示等）被拼进 system prompt，导致每次请求的 system 前缀几乎都不同，供应商侧无法复用已缓存的 system + 历史前缀。
2. **历史消息无截断策略**。`list_message_history()` 返回会话全部历史消息并全量发送。长对话中：
   - 请求 token 随消息数线性增长，成本和延迟持续上升；
   - 如果后续引入"保留最近 N 条"的简单尾部截断，每新增一条消息就会整体左移窗口，破坏前缀稳定性，反而降低缓存命中率。

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 衡量口径 |
|---|------|----------|
| G1 | 提高供应商 prompt cache 前缀命中率 | 相邻两次同会话请求的共享前缀长度占比 ≥ 90%（不含末尾 runtime 快照与最新用户消息）。 |
| G2 | 控制单次请求 token 成本 | 单次请求历史消息数 ≤ 48 条（前缀 8 + 最近 40），超限自动裁剪。 |
| G3 | 保持执行质量不回退 | 内部试用核心流程完成率不低于现有基线（≥ 85%），无因裁剪导致的 P0/P1 问题。 |
| G4 | 行为可观测、可回滚 | 裁剪行为有 debug 日志；策略开关可配置，可一键恢复旧行为。 |

### 2.2 非目标

- 不实现跨会话/跨用户的语义缓存或响应缓存。
- 不改变消息持久化结构（数据库仍保存完整历史）。
- 不在本版本引入 OpenAI/Anthropic 显式 `cache_control` 标记（可作为 v0.2 扩展）。
- 不修改图片/视频生成等其他 AI 链路的上下文组装。

## 3. 方案设计

### 3.1 核心策略：前缀稳定截断（Prefix-Stable Truncation）

```
messages = [
  system (稳定身份+规则, 不含实时快照),
  history[0..8]          ← 锚定前缀: 最早的 8 条
  history[-40..]         ← 最近窗口: 最新 40 条 (与前缀重叠时取并集)
  user (runtime 快照)    ← 本次请求的动态信息, 放在最末尾
]
```

关键规则：

1. **仅当总历史 > PREFIX_KEEP + RECENT_KEEP 时才触发裁剪**；未超限时保持现状（全量历史），保证短会话零影响。
2. **裁剪时保留最早 PREFIX_KEEP 条作为锚定前缀**，丢弃中间段，保留最近 RECENT_KEEP 条。相邻两次请求间，锚定前缀不变、最近窗口只追加不移位（直到再次超过阈值），最大化共享前缀长度。
3. **runtime 快照移出 system prompt**，作为最后一条 user 消息注入。快照中每次变化的字段不再污染可缓存前缀。

### 3.2 参数

| 参数 | 默认值 | 配置方式 |
|------|--------|----------|
| `CHAT_HISTORY_PREFIX_KEEP` | 8 | 常量（后续可提为 env 配置） |
| `CHAT_HISTORY_RECENT_KEEP` | 40 | 常量（后续可提为 env 配置） |
| 总上限（触发阈值） | 48 | = PREFIX_KEEP + RECENT_KEEP |

### 3.3 已实施改动清单（本版本随附）

以下改动已在工作区完成并通过 `cargo check`：

| 文件 | 改动 |
|------|------|
| `server/src/ai/handlers/chat_core.rs` · `build_conversation_messages()` | ① system prompt 不再拼接 `build_execution_prompt()` 输出；② 新增前缀稳定截断逻辑（8 + 40）；③ runtime 快照以末尾 user 消息形式追加。 |
| 同文件 · `build_execution_prompt()` | 新增一行说明："以上项目状态…是本次请求的实时快照…历史消息早于该快照时，以本快照为准"，用于向模型声明快照优先级，降低截断带来的时间线混淆。 |

### 3.4 兼容性与风险控制

| 风险 | 缓解措施 |
|------|----------|
| 模型看不到中间被裁剪的历史，可能丢失早期细节 | 锚定最早 8 条覆盖项目初始设定；runtime 快照包含项目流程概览计数，模型可感知全局进度。 |
| 重试场景下 previous_failures 等动态字段位置变化影响判断 | 这些字段仍在 runtime 快照内，只是从 system 移到末尾 user 消息，语义不变。 |
| 依赖中间历史的边缘 case（如用户引用很早之前的某条消息） | 记录为已知限制；若内部试用出现相关投诉，可将 PREFIX_KEEP 上调或改为摘要压缩（v0.2 方向）。 |
| 回滚需求 | 截断逻辑集中在单一函数，可通过还原该函数快速回到旧行为；后续加 feature flag 后支持运行时切换。 |

## 4. 验收标准

### 4.1 功能验收

- [x] 短会话（≤48 条历史）：请求 messages 数量与改动前一致（仅 system 内容和末尾快照消息有差异）。（单元测试 `short_session_keeps_full_history`）
- [x] 长会话（>48 条历史）：请求 messages 中历史部分 = 前 8 条 + 最近 40 条，且日志输出 `chat history truncated with stable prefix` 及对应统计。（单元测试 `long_session_truncates_with_stable_prefix_and_recent_window`）
- [x] runtime 快照不出现在 system message 中，而是作为最后一条 role=user 的消息存在。（同上两项测试覆盖）
- [x] 所有现有 Rust 测试通过（276 passed）；前端不受影响（本次未改前端代码）。

### 4.2 效果验收（staging / 内部试用期间采集）

| 指标 | 目标 | 数据来源 |
|------|------|----------|
| 相邻请求共享前缀长度占比 | ≥ 90% | 在 client 层记录连续两次请求的 messages 序列化后最长公共前缀字符数 ÷ 较短请求长度 |
| 单次请求平均 input tokens | 较基线下降 ≥ 30%（长会话样本） | usage 表 `prompt_tokens` 字段按会话聚合 |
| P95 首 token 延迟 | 不高于基线 | SSE 首事件时间戳 |
| 核心流程完成率 | ≥ 85% | Phase D 内部试用日报 |
| 因上下文丢失导致的重试/人工介入 | 无新增归因 | 试用问题清单标注 |

### 4.3 Go/No-Go

- **Go（合入主线并进入下一迭代）**：4.1 全部通过 + 效果指标达标 + 无 P0/P1。
- **No-Go**：任一功能项失败，或出现因截断导致的 P0/P1 质量问题；修复后重新验证。

## 5. 后续方向（v0.2 备选）

| 方向 | 说明 |
|------|------|
| 显式 `cache_control` | 为 OpenAI-compatible 网关或 Anthropic API 添加 ephemeral 缓存标记，显式声明可缓存前缀边界。 |
| 中间历史摘要压缩 | 被裁剪的中间段用低成本模型生成一段摘要，替换为一条 system/user 消息插在前缀之后，兼顾上下文完整性与前缀稳定性。 |
| 参数运行时可调 | 将 PREFIX_KEEP / RECENT_KEEP 从常量提升为 `AI_CHAT_HISTORY_PREFIX_KEEP` / `AI_CHAT_HISTORY_RECENT_KEEP` 环境变量。 |
| 命中率监控面板 | 在 Usage Dashboard 增加 per-conversation cache hit rate 曲线。 |

## 6. 关联资料

- [封闭 Beta 稳定化 PRD v1.2](../../closed-beta-stabilization/v1.2/closed-beta-stabilization-prd-v1.2.md)
- [多智能体编排规划书](../../../multi-agent-orchestrator-beta-plan.md)
- 实施代码：`server/src/ai/handlers/chat_core.rs`
