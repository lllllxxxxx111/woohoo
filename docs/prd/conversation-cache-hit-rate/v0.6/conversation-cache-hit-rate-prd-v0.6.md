# Woohoo 会话缓存命中率优化 PRD：命中率趋势图

版本：v0.6  
日期：2026-09-05  
状态：已实施  
前序版本：[v0.5 流式 usage 透传](../v0.5/conversation-cache-hit-rate-prd-v0.5.md)  
适用阶段：Phase C 真实 staging 演练通过后的下一迭代候选（对应工程安排工作流 D1）

## 1. 背景与范围

v0.4 面板提供了「当下」的命中率（总览卡 + 会话排行），但没有时间维度——
无法回答「截断策略上线后命中率是否随时间改善」「某天是否出现前缀稳定性回退」。
series 数据（v0.3 起按时间桶聚合）只缺每桶的分母 `prompt_tokens`。

本版本范围：

1. 后端 series 聚合补齐每桶 `prompt_tokens`（命中率分母）。
2. 前端 Usage Dashboard 新增「缓存命中率趋势」：纯 CSS 柱状图，无图表库依赖。

不属于本版本：中间历史摘要压缩、显式 `cache_control`（工作流 D2/D3，等效果数据决策）。

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 衡量口径 |
|---|------|----------|
| G1 | series 每桶带 prompt_tokens 分母 | `fetch_series` 增加 `SUM(prompt_tokens)`，与 breakdown 口径一致（分母含未上报请求）；补 DB 级聚合测试 |
| G2 | Dashboard 呈现命中率随时间桶的变化 | 有上报数据的桶显示命中率柱，无上报桶灰色占位（≠ 命中率为 0） |
| G3 | 悬浮明细可读 | 每桶 title 展示：命中率、命中/全部 tokens、上报次数、请求数 |
| G4 | 长窗口不失真 | 小时桶 × 长窗口（可达上千桶）最多渲染最近 60 桶并在标题注明 |

### 2.2 非目标

- 不引入图表库（保持零新依赖；趋势为单指标柱状图，CSS 足够）。
- 不做多指标叠加（如 tokens 绝对值第二轴）——等 staging 数据反馈后再定。

## 3. 方案与实施

| 文件 | 改动 |
|------|------|
| `server/src/ai/usage.rs` | `fetch_series` SQL 增加 `SUM(prompt_tokens)`；`SeriesRow` / `AiUsageSeriesPoint` 增加 `prompt_tokens`；新增 `series_aggregation_tests`（临时库 + 全列建表 + 跨两日三事件，断言每桶分母/分子/上报记录数）。 |
| `src/lib/serverApi.ts` | `AiUsageSeriesPoint.promptTokens`。 |
| `src/components/Settings/UsageDashboard.tsx` | `CacheHitTrendChart`（纯 CSS 柱状图 + title 悬浮 + 标签抽稀 + 60 桶上限），置于统计卡与 breakdown 之间的全宽卡片；`AiUsageSeriesPoint` 类型引入。 |

关键展示口径：

- 每桶命中率 = `cachedPromptTokens / promptTokens`（分母含未上报请求，与总览卡一致，保守口径）。
- `cachedTokenRecords === 0` 的桶为灰色占位矮柱——「无数据」不画成 0%。
- 桶标签：day/week/month 显示 `MM-DD`，hour 显示 `MM-DD HH时`；过密时按步长抽稀，首尾必留。

## 4. 验收标准

### 4.1 功能验收（2026-09-05 本地门禁）

- [x] DB 级聚合测试 `fetch_series_aggregates_prompt_tokens_per_bucket`：跨桶分母含未上报请求、分子只含有上报值、`COUNT(cached_prompt_tokens)` 区分无数据与 0 命中。
- [x] `cargo test` 299 passed（+1）；fmt 通过；clippy 127 → 127 零新增。
- [x] 前端 lint 0 error（8 存量不变）、build（tsc + vite）、286 tests 通过。
- [x] 无新依赖（package.json 未变）。

### 4.2 效果验收（staging / 内部试用期间采集）

趋势图本身无独立效果指标；它服务 v0.3 第 4.2 节的采集目标——观察命中率随时间的走势与突变点，
配合截断开关演练（工作流 B）做前后对照。

## 5. 后续方向（v0.7 备选）

| 方向 | 说明 |
|------|------|
| 中间历史摘要压缩 | 被裁剪的中间段用低成本模型生成摘要（工作流 D2，需评估脚本）。 |
| 显式 `cache_control` | 按端点能力位实现 ephemeral 缓存标记（工作流 D3，等效果数据）。 |
| 趋势图增强 | 双指标（命中率 + tokens 量）、缩放交互——视 staging 反馈决定。 |

## 6. 关联资料

- [v0.5 流式 usage 透传 PRD](../v0.5/conversation-cache-hit-rate-prd-v0.5.md)
- [工程安排 2026-09](../../../engineering-roadmap-202609.md)
- 实施代码：`server/src/ai/usage.rs`、`src/components/Settings/UsageDashboard.tsx`
