# 预算管理（Budget Management）

Woohoo Studio 预算管理闭环：让个人/小团队在多 AI endpoint 接入场景下，避免图像、视频、长文本任务无上限地消耗积分或 token。

## 功能概览

- 用户可在「设置 → 预算管理」配置日预算、月预算、预警阈值、超限策略
- 后端在创建 AI 任务（图片生成、视频生成、流式对话、同步对话、AI 队列任务）前统一经过 `check_gate` 闸门
- 若当日/当月已超出预算，或本次任务预计会让预算超限，直接返回 `402 BUDGET_EXCEEDED`
- 预算事件（warning / blocked）全部落库到 `budget_events` 表，前端展示最近 10 条拦截/预警原因

## 数据库

新增两张表：

- `user_budget_settings` 一行一用户，存储日/月预算、阈值、超限策略、启用状态
- `budget_events` 预算事件流水（warning / blocked）

迁移文件：`server/migrations/018_budget_management.sql`，会被 `db::run_schema_migrations` 自动执行。

## 后端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/api/billing/budget` | 获取预算快照（设置 + 当日/当月已消耗 + 使用率 + 状态） |
| PUT  | `/api/billing/budget` | 更新预算配置（任意字段可单独提交） |
| GET  | `/api/billing/budget/events` | 最近 50 条预算事件（预警 + 拦截） |

错误码：
- `BUDGET_EXCEEDED` (HTTP 402)：本次任务被预算拦截，响应体包含 `error` 字段为人类可读原因

## 后端模块

```
server/src/billing/
  mod.rs
  model.rs            # 既有：积分余额、流水
  repo.rs             # 既有：扣积分、退款
  handlers.rs         # 既有：余额/流水查询
  budget_model.rs     # 新增：预算数据结构 + 闸门决策类型
  budget_repo.rs      # 新增：预算 CRUD + check_gate 核心闸门
  budget_handlers.rs  # 新增：3 个 HTTP 路由
```

`budget_repo::check_gate` 是核心逻辑：

1. 取预算快照（已用日/月积分）
2. 未启用预算或无任何 limit，直接 `Allow`
3. 已超限 → `Block` 并落库 `blocked` 事件
4. 若调用方传了 `estimated_cost`，则预估本次后是否超限 → `Block`
5. 已达预警阈值 → `Warn` 并落库 `warning` 事件（同一天/月只发一次）
6. 其余 → `Allow`

## 拦截接入点

| 路径 | 文件 |
| --- | --- |
| 图片生成 | `server/src/image_gen/handlers.rs::create_generation` |
| 视频生成 | `server/src/video_gen/handlers.rs::create_generation` |
| 同步 chat | `server/src/ai/handlers.rs::ai_chat` |
| 流式 chat | `server/src/ai/handlers.rs::ai_chat_stream` |
| AI 队列任务 | `server/src/ai/task_handlers.rs::create_task` |

chat/stream/task 没有预扣费（按 token 计费），所以只检查"是否已超限"，不做"本次预计是否超限"的预估。
image/video 已有明确 cost，会传给 `check_gate(estimated_cost)`。

## 前端

| 文件 | 说明 |
| --- | --- |
| `src/lib/serverApi.budget.ts` | API 客户端 + 类型定义 |
| `src/hooks/useBudget.ts` | React hook：拉取预算快照 + 事件、暴露 `reload` |
| `src/components/Settings/BudgetSettings.tsx` | 设置中心预算管理面板 |
| `src/components/Settings/SettingsModal.tsx` | 新增「预算管理」标签页 |

预算面板功能：
- 顶部 alert：当前预算状态（超限 / 预警 / 正常）
- 进度条：日/月预算使用率
- 配置表单：日/月预算、预警阈值、超限策略（block / warn_only）、启用开关
- 最近预算事件列表（带类型标签、资源类型、原因）

## 后续可扩展点

1. 不同资源类型独立预算（如图片日预算 50，对话日预算 100）
2. 预警通知接入 `notification_channels` 推送
3. chat/task 的预估 cost 接入：可基于模型定价表 × max_tokens 估算
4. 预算重置周期可配置（周一/月初 / 自定义）
5. 团队/项目级预算（继承 user 配额，向下分配）
