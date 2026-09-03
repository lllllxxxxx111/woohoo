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

## Restart Recovery Contract

The server performs a conservative recovery pass during startup before it begins serving traffic:

- persisted `queued` and `running` AI tasks that were interrupted by the previous process are changed to `failed`, with a user-visible error and `last_error` explaining that the task was interrupted and can be retried;
- only rows that are still in an interrupted state are updated, so a repeated restart does not emit duplicate recovery side effects;
- pipeline steps whose AI task no longer exists or is no longer runnable are changed from `running` to `failed` and receive a `recovery_failed` event;
- image/video reconciliation remains the source of truth for provider-side results. Automatic retry is allowed only where the provider operation is idempotent; otherwise the item remains available for controlled retry or manual review.

The recovery policy intentionally prefers a visible, actionable failure over an indefinite `running` record. Operators should use the task/pipeline detail and event history to retry or route the item to manual handling.

## Beta Alert Contract

The inspector should page the on-call role when any of these conditions is present for two consecutive inspection windows. Thresholds are starting points and must be tuned from the first week of Beta data:

| Signal | Warning | Critical | First response |
| --- | ---: | ---: | --- |
| queued AI tasks | 10 tasks or oldest > 5 min | 30 tasks or oldest > 15 min | check provider latency, concurrency and stuck tasks |
| failed task rate (15 min) | > 10% | > 25% | classify provider, auth, quota and application errors |
| recovery failures after restart | >= 1 | >= 3 | inspect `recovery_failed`, retry or manually close affected steps |
| provider failures (15 min) | > 5 events | > 15 events | check provider status, credentials and rate limits |
| disk usage on `/data` | > 70% | > 85% | remove expired temporary uploads and expand/rotate storage |

The responsible role is the release/operations owner during Beta; backend owns the query and event contract, while product/operations owns the weekly summary and escalation decision. Never include API keys or full user prompts in findings or notifications.

## Current Limits

- The Beta deployment is a single server process backed by SQLite; horizontal scaling and an external queue are deliberately out of scope.
- Inspector findings are currently service-scoped, not yet project- or conversation-scoped.
- Email / Telegram dispatch is not wired yet.
- Pipeline Orchestrator and AI task persistence are now part of the current runtime. The historical multi-agent plan describes future extensions, not a missing orchestrator.
