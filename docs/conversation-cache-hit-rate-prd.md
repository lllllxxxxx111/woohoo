# Woohoo 会话缓存命中率优化 PRD 索引

本主题的 PRD 按版本独立归档。新工作必须以当前执行版本为准，历史版本仅用于追溯决策和验收证据。

| 版本 | 状态 | 说明 |
| --- | --- | --- |
| [v0.5](prd/conversation-cache-hit-rate/v0.5/conversation-cache-hit-rate-prd-v0.5.md) | 已实施 | 当前执行基线：流式 usage 透传——`stream_options.include_usage` + 流内 usage 解析 + 400/422 自动降级，流式记录升级为实际 usage（含缓存命中）。 |
| [v0.4](prd/conversation-cache-hit-rate/v0.4/conversation-cache-hit-rate-prd-v0.4.md) | 已实施 | 命中率监控面板——总览命中率卡、会话命中率面板、breakdown 标注、流水前缀命中列（纯前端增量）。 |
| [v0.3](prd/conversation-cache-hit-rate/v0.3/conversation-cache-hit-rate-prd-v0.3.md) | 已实施，待 staging 采集 | 命中率可观测——供应商缓存命中 tokens 解析入库、服务端前缀探针、Usage summary 聚合透出（数据采集层）。 |
| [v0.2](prd/conversation-cache-hit-rate/v0.2/conversation-cache-hit-rate-prd-v0.2.md) | 已实施 | 截断参数与开关运行时可调（`AI_CHAT_HISTORY_*`），一键恢复旧行为。 |
| [v0.1](prd/conversation-cache-hit-rate/v0.1/conversation-cache-hit-rate-prd-v0.1.md) | 已实施 | 前缀稳定截断（8/40）与 runtime 快照移出 system prompt；效果指标待 staging / 内部试用采集。 |

关联基线：[封闭 Beta 稳定化 PRD v1.2](closed-beta-stabilization-prd.md)。
