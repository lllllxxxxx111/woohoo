# Backend Ops Monitoring Contract

## Scope

The backend now includes a first monitoring skeleton for:

- runtime heartbeats
- automated inspection findings
- notification channel persistence
- user-queryable ops overview APIs

This is the backend contract for later巡检员 / IM / email integration work.

## Runtime Workers

Two background loops now start with the server process:

- heartbeat loop
- inspection loop

Config:

- `OPS_HEARTBEAT_INTERVAL_SECS` default `15`
- `OPS_INSPECTION_INTERVAL_SECS` default `30`
- `OPS_STALE_TASK_AFTER_SECS` default `600`
- `OPS_FAILURE_WINDOW_MINUTES` default `15`

## Heartbeats

Table: `runtime_heartbeats`

Current components:

- `server`
- `ai-runtime`
- `inspector`
- `notifier`

Status values:

- `healthy`
- `warning`
- `critical`

`server` heartbeat includes:

- host
- port
- pid
- uptime
- configured concurrency

`ai-runtime` heartbeat includes:

- total tasks
- queued tasks
- running tasks
- completed tasks
- failed tasks
- oldest queued age
- oldest running age

`inspector` heartbeat includes:

- latest queue/runtime snapshot
- recent usage failure window

## Findings

Table: `inspection_findings`

Current automated checks:

- `runtime.queue_backlog`
- `runtime.stale_running`
- `runtime.stale_queue`
- `usage.high_failure_rate`

Severity values:

- `info`
- `warning`
- `critical`

Status values:

- `open`
- `resolved`

Current checks are service-scoped. The schema already supports later user-scoped findings through nullable `user_id`.

## Notification Channels

Table: `notification_channels`

Supported channel types:

- `email`
- `webhook`
- `feishu`
- `dingtalk`
- `wecom`
- `slack`
- `telegram`
- `other`

This layer now persists channel definitions and supports live outbound delivery for:

- `feishu`
- `webhook`
- `dingtalk`
- `wecom`
- `slack`

Current non-live channel types:

- `email`
- `telegram`

Those types are accepted by schema/API, but the sender is not wired yet.

## Notification Events

Table: `notification_events`

This is the future outbox for IM / email dispatchers.

Current status:

- schema exists
- summary counts are exposed in overview
- queued events are dispatched by a background worker
- retry / failure audit is persisted

## APIs

All `/api/ops/*` routes are authenticated.

### `GET /api/ops/overview`

Returns:

- latest heartbeat snapshots
- active findings visible to the current user
- current in-memory task snapshot
- recent usage failure window
- notification channel / event summary

### `GET /api/ops/heartbeats`

Returns latest heartbeat rows, ordered by severity and recency.

### `GET /api/ops/findings`

Query params:

- `limit`
- `includeResolved`

Returns global findings plus findings owned by the current user.

### `GET /api/ops/notification-channels`

Lists the current user's configured notification channels.

### `POST /api/ops/notification-channels/test`

Sends a one-off live test notification without persisting the channel definition.

Request shape:

```json
{
  "channelType": "feishu",
  "target": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
  "title": "Woohoo 巡检测试通知",
  "message": "这是一条测试通知。"
}
```

### `POST /api/ops/notification-channels`

Creates a notification channel.

Request shape:

```json
{
  "name": "ops-email",
  "channelType": "email",
  "target": "ops@example.com",
  "config": {
    "language": "zh-CN"
  },
  "isEnabled": true
}
```

### `PUT /api/ops/notification-channels/:id`

Updates a notification channel owned by the current user.

### `DELETE /api/ops/notification-channels/:id`

Deletes a notification channel owned by the current user.

### `GET /api/ops/notification-events`

Returns the current user's recent notification audit events.

## Current Limits

- Task runtime state is still process-local memory. A restart clears in-flight task snapshots.
- Inspector findings are currently service-level, not yet project-level or conversation-level.
- Email / Telegram dispatch is not wired yet.
- There is no dedicated巡检员 agent orchestration yet; this release only provides the backend monitoring substrate it will need.
