# AI 成本预算控制功能使用说明

## 功能概述

Woohoo Studio 现在支持用户级 AI 成本预算控制功能，可以防止图像/视频/长文本任务无限消耗 token 或积分。

## 功能特性

1. **预算配置**：支持日预算和月预算上限设置
2. **预警机制**：当消耗达到预警比例时显示提示
3. **超限拦截**：超过预算上限时自动拦截高成本 AI 任务
4. **拦截记录**：记录所有预算拦截事件，便于审计
5. **友好提示**：预算超限时显示明确的提示信息

## 使用方法

### 1. 配置预算

1. 打开设置页（点击左下角设置图标）
2. 选择「预算控制」标签页
3. 启用预算控制开关
4. 配置以下参数：
   - **日预算上限**：每日累计消耗超过此值后将拦截 AI 请求（留空表示不限制）
   - **月预算上限**：每月累计消耗超过此值后将拦截 AI 请求（留空表示不限制）
   - **预警比例**：当使用率达到此比例时将显示预警提示（取值范围 0-1，默认 0.8）
5. 点击「保存配置」按钮

### 2. 查看预算状态

在预算控制页面可以查看：
- 今日/本月消耗和预算上限
- 使用率进度条（绿色=正常，橙色=预警，红色=超限）
- 预算状态标签
- 最近的预算拦截记录

### 3. 预算超限处理

当预算超限时：
- AI 请求会被自动拦截
- 聊天界面会显示友好的提示信息：「⚠️ 预算超限：... 请前往「设置 > 预算控制」调整预算上限，或等待日/月预算周期重置。」
- 可以在预算控制页面查看拦截记录

## API 说明

### 获取预算状态

```
GET /api/billing/budget
```

响应示例：
```json
{
  "config": {
    "id": "xxx",
    "userId": "user_xxx",
    "dailyCreditLimit": 10,
    "monthlyCreditLimit": 100,
    "warnRatio": 0.8,
    "isEnabled": true,
    "createdAt": "2026-07-01T00:00:00Z",
    "updatedAt": "2026-07-01T00:00:00Z"
  },
  "dailyUsage": 5.2,
  "monthlyUsage": 32.5,
  "dailyUsageRatio": 0.52,
  "monthlyUsageRatio": 0.325,
  "isDailyWarning": false,
  "isMonthlyWarning": false,
  "isDailyExceeded": false,
  "isMonthlyExceeded": false,
  "hasWarning": false,
  "hasExceeded": false
}
```

### 更新预算配置

```
PUT /api/billing/budget
```

请求体：
```json
{
  "dailyCreditLimit": 10,
  "monthlyCreditLimit": 100,
  "warnRatio": 0.8,
  "isEnabled": true
}
```

### 获取拦截记录

```
GET /api/billing/budget/blocks
```

响应示例：
```json
[
  {
    "id": "xxx",
    "userId": "user_xxx",
    "operation": "task",
    "reason": "daily_exceeded",
    "currentUsage": 10.5,
    "limitValue": 10,
    "requestDetails": null,
    "createdAt": "2026-07-01T12:00:00Z"
  }
]
```

## 预算计算规则

- 预算单位：积分
- 转换规则：1000 token = 1 积分
- 数据来源：从 `ai_usage_events` 表聚合 `total_tokens` 字段
- 统计范围：只统计状态为 `success` 的请求

## 错误处理

当预算超限时，API 返回：
- 状态码：402 Payment Required
- 错误码：`BUDGET_EXCEEDED`
- 错误消息：「预算超限：日预算 当前已使用 10.50 积分，上限 10.00 积分。请调整预算或等待周期重置。」

## 数据库表结构

### user_budget_configs 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 主键 |
| user_id | TEXT | 用户 ID，外键关联 users 表 |
| daily_credit_limit | REAL | 日预算上限（NULL 表示不限制） |
| monthly_credit_limit | REAL | 月预算上限（NULL 表示不限制） |
| warn_ratio | REAL | 预警比例（0-1） |
| is_enabled | INTEGER | 是否启用（1=启用，0=禁用） |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

### budget_blocks 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 主键 |
| user_id | TEXT | 用户 ID，外键关联 users 表 |
| operation | TEXT | 操作类型（chat/stream/task/test） |
| reason | TEXT | 拦截原因（daily_exceeded/monthly_exceeded） |
| current_usage | REAL | 当前消耗积分 |
| limit_value | REAL | 预算上限积分 |
| request_details | TEXT | 请求详情（JSON 格式，可选） |
| created_at | TEXT | 拦截时间 |

## 验证方法

### 1. 数据库迁移验证

启动后端服务，检查数据库中是否创建了 `user_budget_configs` 和 `budget_blocks` 表：

```sql
SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%budget%';
```

### 2. API 验证

1. 登录后调用 `GET /api/billing/budget`，应该返回默认预算配置（未配置时返回 NULL 限制）
2. 调用 `PUT /api/billing/budget` 设置一个很小的预算（比如日预算 0.1 积分）
3. 再次调用 `GET /api/billing/budget`，确认预算已更新
4. 发起 AI 聊天请求，应该被拦截并返回预算超限错误

### 3. 前端验证

1. 打开设置页，确认「预算控制」标签页存在
2. 配置预算并保存，确认保存成功
3. 发起 AI 请求，当预算超限时确认显示友好的提示信息
4. 查看拦截记录，确认拦截事件被正确记录

## 注意事项

1. 预算消耗基于成功的 AI 请求，失败的请求不会计入消耗
2. 日预算按自然日重置，月预算按自然月重置
3. 预算配置只对当前登录用户生效
4. 禁用预算控制后，不会进行预算检查
5. 积分计算基于 token 消耗，与实际计费可能有细微差异
