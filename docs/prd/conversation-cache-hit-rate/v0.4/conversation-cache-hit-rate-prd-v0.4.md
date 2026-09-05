# Woohoo 会话缓存命中率优化 PRD：命中率监控面板

版本：v0.4  
日期：2026-09-05  
状态：已实施  
前序版本：[v0.3 命中率可观测（指标采集层）](../v0.3/conversation-cache-hit-rate-prd-v0.3.md)  
适用阶段：Phase C 真实 staging 演练通过后的下一迭代候选

## 1. 背景与范围

v0.3 已建立命中率数据管道（`ai_usage_events.cached_prompt_tokens` / `prompt_prefix_hit_ratio`、
Usage summary 的 totals / series / by_conversation / breakdown 命中率），但前端 Usage Dashboard
完全不消费这些字段——运营和开发者仍无法在界面上回答「截断策略带来多少缓存收益」。

本版本范围：**Usage Dashboard 呈现缓存命中率**。

不属于本版本：流式 usage 透传（`stream_options.include_usage`）、显式 `cache_control` 标记、
中间历史摘要压缩（保留为后续方向）。

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 衡量口径 |
|---|------|----------|
| G1 | 总览新增「缓存命中率」指标卡 | `cachedTokenRecords > 0` 时显示 `cachedPromptTokens / promptTokens`，否则显示 `—`（无数据 ≠ 0） |
| G2 | 新增「会话缓存命中率」面板（by_conversation） | 每会话一行：命中率（核心指标）、请求数、缓存命中 tokens、积分、上报次数；超过 5 项可展开 |
| G3 | 各 breakdown（项目 / 智能体 / 产出类型）命中率标注 | 仅当该项 `cacheHitRatio` 非 null 时追加展示，不污染无数据场景 |
| G4 | 近期调用流水新增「前缀命中」列 | 展示单条记录的服务端探针占比 `promptPrefixHitRatio`（首请求为 `—`） |
| G5 | 前端类型与后端 v0.3 契约对齐 | `AiUsageSummary` / `AiUsageTotals` / `AiUsageBreakdownItem` / `AiUsageSeriesPoint` / `AiUsageRecord` 补齐缓存字段 |

### 2.2 非目标

- 不做趋势曲线/图表（series 缓存字段已在类型中就绪，图表组件留待后续迭代）。
- 不改动后端（本次为纯前端增量，后端 API 契约沿用 v0.3）。
- 不改前端既有 lint 存量（8 个既有 warning 保持不变）。

## 3. 方案与实施

| 文件 | 改动 |
|------|------|
| `src/lib/serverApi.ts` | 五个 usage 类型补齐 v0.3 新增字段（camelCase，与后端 serde 对齐）。 |
| `src/components/Settings/UsageDashboard.tsx` | `formatHitRatio` 辅助函数（null → `—`）；`createEmptySummary` 补默认值；`statsGrid` 第 5 张「缓存命中率」卡片；`breakdownGrid` 首位新增 `ConversationCacheSection`（复用 breakdown 卡片样式）；`BreakdownSection` meta 追加条件性命中率标注；流水表新增「前缀命中」列（scroll 宽度 740 → 990）。 |

关键展示口径：

- **无数据与命中率为 0 严格区分**：`cacheHitRatio === null`（供应商未上报）显示 `—`；
  `cachedTokenRecords === 0` 时总览卡片显示 `—` 并注明「供应商未上报缓存命中数据」。
- **总览卡片分母说明**：分母为窗口内全部 prompt tokens（含估算与未上报请求），
  命中率为保守的整体收益口径；会话面板的命中率则基于该会话有上报记录的 tokens，
  与后端 breakdown 口径一致。footer 中展示命中 / 全部 prompt tokens 原始值。

## 4. 验收标准

### 4.1 功能验收（2026-09-05 本地门禁）

- [x] `npm run lint`：0 error（8 个既有 warning 不变）。
- [x] `npm run build`（tsc + vite）：通过，类型与后端 camelCase 契约对齐。
- [x] `npm test`：286 passed（前端无既有 Dashboard 测试，本版本不新增测试文件，与前端现状一致）。
- [x] 后端无代码改动，Rust 门禁沿用 v0.3 结果（294 tests / clippy 零新增）。

### 4.2 效果验收（staging / 内部试用期间采集）

面板本身无效果指标；其存在的目的即服务 v0.3 第 4.2 节的 staging 采集——
运营可直接在面板观察：整体命中率卡、会话命中率排行、单请求前缀命中，
并与「截断开关演练」（`AI_CHAT_HISTORY_TRUNCATION_ENABLED=false`）前后对比。

## 5. 后续方向（v0.5 备选）

| 方向 | 说明 |
|------|------|
| 流式 usage 透传 | 流式客户端请求 `stream_options.include_usage` 并解析流内 usage 块，补齐流式记录的供应商命中 tokens（目前流式记录命中率为 `—`）。 |
| 命中率趋势图 | 用 series 中已就绪的 `cachedPromptTokens / cachedTokenRecords` 画时间趋势曲线。 |
| 显式 `cache_control` | 为 OpenAI-compatible 网关或 Anthropic API 添加 ephemeral 缓存标记。 |
| 中间历史摘要压缩 | 被裁剪的中间段用低成本模型生成摘要，替换为一条消息插在前缀之后。 |

## 6. 关联资料

- [v0.3 命中率可观测 PRD](../v0.3/conversation-cache-hit-rate-prd-v0.3.md)
- [v0.2 参数运行时可调 PRD](../v0.2/conversation-cache-hit-rate-prd-v0.2.md)
- [v0.1 会话缓存命中率优化 PRD](../v0.1/conversation-cache-hit-rate-prd-v0.1.md)
- [封闭 Beta 稳定化 PRD v1.2](../../closed-beta-stabilization/v1.2/closed-beta-stabilization-prd-v1.2.md)
- 实施代码：`src/lib/serverApi.ts`、`src/components/Settings/UsageDashboard.tsx`
