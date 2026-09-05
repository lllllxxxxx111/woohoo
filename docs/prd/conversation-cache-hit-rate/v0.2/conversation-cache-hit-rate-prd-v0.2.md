# Woohoo 会话缓存命中率优化 PRD：参数运行时可调与截断开关

版本：v0.2  
日期：2026-09-03  
状态：已实施，待本地门禁与 staging 采集  
前序版本：[v0.1 会话缓存命中率优化 PRD](../v0.1/conversation-cache-hit-rate-prd-v0.1.md)  
适用阶段：Phase C 真实 staging 演练通过后的下一迭代候选

## 1. 背景与范围

v0.1 已实现前缀稳定截断（`8 + 40`）与 runtime 快照移出 system prompt，但两个关键点仍是硬编码/缺位：

1. **截断窗口参数为常量**。`CHAT_HISTORY_PREFIX_KEEP = 8`、`CHAT_HISTORY_RECENT_KEEP = 40` 写死在 `chat_core.rs`，调整窗口需要改代码重新构建发布。
2. **无运行时回滚开关**。v0.1 目标 G4 要求“策略开关可配置，可一键恢复旧行为”，实际只能通过还原代码回滚；若 staging / 内部试用发现截断引发质量问题，无法在部署层面快速关闭。

本版本范围：把上述参数与开关提升为启动环境变量配置。不属于本版本：显式 `cache_control` 标记、中间历史摘要压缩、命中率监控面板（保留为后续方向）。

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 衡量口径 |
|---|------|----------|
| G1 | 截断窗口参数可经环境变量调整，无需改代码 | `AI_CHAT_HISTORY_PREFIX_KEEP` / `AI_CHAT_HISTORY_RECENT_KEEP` 生效并有单测覆盖 |
| G2 | 提供一键恢复旧行为的开关 | `AI_CHAT_HISTORY_TRUNCATION_ENABLED=false` 时发送全量历史（与 v0.1 之前行为一致），有单测覆盖 |
| G3 | 默认行为与 v0.1 完全一致 | 未设置环境变量时，请求消息组装结果与 v0.1 逐字节一致（默认 8/40、截断开启） |
| G4 | 部署层可操作 | 三套 Compose、`.env.example`、`docker-deploy.md` 均暴露新变量 |

### 2.2 非目标

- 不改变截断算法本身（仍是前缀稳定截断，锚定最早轮次 + 最近窗口）。
- 不支持运行期热更新（重启生效；`AppConfig` 在启动时构建一次）。
- 不引入参数运行时校验告警面板或监控指标。

## 3. 方案与实施

### 3.1 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `AI_CHAT_HISTORY_TRUNCATION_ENABLED` | `true` | 设为 `false` 关闭前缀稳定截断，恢复全量历史旧行为 |
| `AI_CHAT_HISTORY_PREFIX_KEEP` | `8` | 截断时保留的最早轮次数量（锚定前缀） |
| `AI_CHAT_HISTORY_RECENT_KEEP` | `40` | 截断时保留的最近消息数量 |

触发阈值 = `PREFIX_KEEP + RECENT_KEEP`；仅当总历史超过阈值才裁剪，短会话零影响。解析失败时回落默认值（`unwrap_or`），不阻塞启动。

### 3.2 实施改动

| 文件 | 改动 |
|------|------|
| `server/src/config.rs` | `AppConfig` 新增 `ai_chat_history_truncation_enabled` / `ai_chat_history_prefix_keep` / `ai_chat_history_recent_keep` 三个字段与解析；新增测试辅助 `test_config()`（仅测试编译）。 |
| `server/src/ai/handlers/chat_core.rs` | 删除硬编码常量，新增 `ChatHistoryPolicy` 结构（`from_config` + `max_history`）；`prepare_chat_request` 改为接收 `&AppState` 并从 `state.config` 构建策略；`assemble_chat_messages` 按 `policy.truncation_enabled` 与窗口执行截断。 |
| `server/src/ai/handlers.rs` | 三处 `prepare_chat_request(&state.db, ...)` 调用点改为 `prepare_chat_request(&state, ...)`。 |
| `docker-compose.yml` / `docker-compose.demo.yml` / `docker-compose.production.yml` | 透传三个环境变量（带安全默认值）。 |
| `server/.env.example`、`docs/docker-deploy.md` | 记录三个新变量。 |

### 3.3 回滚方式

1. **运行时回滚（本版本新增能力）**：`AI_CHAT_HISTORY_TRUNCATION_ENABLED=false` 重启服务，即恢复全量历史行为；窗口参数亦可独立调整。
2. **代码回滚**：还原 `chat_core.rs` / `config.rs` / `handlers.rs` 本次改动即可回到 v0.1 硬编码行为。

## 4. 验收标准

### 4.1 功能验收

- [x] 未设置环境变量时策略为默认（开启、8/40）：`policy_from_config_matches_fields` 及既有 `short_session_keeps_full_history`、`long_session_truncates_with_stable_prefix_and_recent_window` 覆盖。
- [x] `truncation_enabled=false` 时发送全量历史：`truncation_disabled_keeps_full_history`。
- [x] 自定义窗口（如 2/3）按配置生效：`custom_policy_uses_configured_window`。
- [x] `PREFIX_KEEP=0` 边界不 panic，仅保留最近窗口：`zero_prefix_keeps_only_recent_window`。
- [x] `cargo test` 全部通过（280 passed）；`cargo fmt --check` 通过；clippy 无新增警告。
- [x] 三套 Compose `config` 校验通过；`lint` / `typecheck` / `test` / `build` 前端门禁通过（前端无代码改动）。

### 4.2 效果验收（staging / 内部试用期间采集）

沿用 v0.1 第 4.2 节指标（共享前缀占比 ≥ 90%、input tokens 下降、P95 首 token 延迟、核心流程完成率）。本版本新增关注点：

| 指标 | 目标 | 数据来源 |
|------|------|----------|
| 开关回滚演练 | 在 staging 将 `AI_CHAT_HISTORY_TRUNCATION_ENABLED=false` 后，长会话请求历史消息数恢复为全量 | 演练记录 + 请求日志 |

## 5. 后续方向（v0.3 备选）

| 方向 | 说明 |
|------|------|
| 显式 `cache_control` | 为 OpenAI-compatible 网关或 Anthropic API 添加 ephemeral 缓存标记，显式声明可缓存前缀边界。 |
| 中间历史摘要压缩 | 被裁剪的中间段用低成本模型生成摘要，替换为一条消息插在前缀之后。 |
| 命中率监控面板 | 在 Usage Dashboard 增加 per-conversation cache hit rate 曲线；补充效果指标自动采集。 |

## 6. 关联资料

- [v0.1 会话缓存命中率优化 PRD](../v0.1/conversation-cache-hit-rate-prd-v0.1.md)
- [封闭 Beta 稳定化 PRD v1.2](../../closed-beta-stabilization/v1.2/closed-beta-stabilization-prd-v1.2.md)
- [Docker 部署说明](../../../docker-deploy.md)
- 实施代码：`server/src/ai/handlers/chat_core.rs`、`server/src/config.rs`
