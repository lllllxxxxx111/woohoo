# AI Backend Runtime Contract

## Scope

The backend now supports the missing runtime capabilities that were previously only implied in the UI:

- Real async AI task execution with queueing
- Real per-user agent runtime status and task counts
- Real SSE task subscription
- Project/conversation isolation for multi-project usage
- Compatibility with existing sync and streaming chat endpoints

This document is the contract for the frontend and for later performance work.

## Runtime Model

### Concurrency

- `AI_MAX_CONCURRENT_TASKS` controls the AI task worker concurrency.
- Default value: `10`
- The runtime uses a process-local semaphore to cap parallel AI executions.
- SQLite pool size is derived from the task concurrency and currently uses `max(10, AI_MAX_CONCURRENT_TASKS) + 4`.
- SQLite remains in WAL mode with `busy_timeout=5s`.

This means the server can accept more than 10 task submissions immediately, queue them, and run up to 10 AI jobs in parallel without blocking the request path.

### Port Failover

- The backend no longer hard-fails on a single fixed port.
- It starts at `PORT` and then probes forward up to `PORT + PORT_SEARCH_LIMIT`.
- Default search window: `8080` through `8092`.
- Windows `AddrInUse` and `PermissionDenied` bind failures are both treated as port-unavailable and will trigger the next candidate port.
- The chosen port is written to the runtime manifest at `RUNTIME_MANIFEST_PATH`.

Example manifest:

```json
{
  "service": "woohoo-server",
  "host": "127.0.0.1",
  "port": 8081,
  "baseUrl": "http://127.0.0.1:8081",
  "healthUrl": "http://127.0.0.1:8081/health"
}
```

### Isolation

- Every AI task is bound to one `conversationId`.
- `conversationId` is resolved back to the owning `projectId`.
- History is loaded only from that conversation.
- Cross-project `@agent` usage does not merge histories.
- Agent usage counts are scoped to the authenticated user.

## Endpoints

### `GET /health`

Health check is public and now returns structured runtime info:

```json
{
  "status": "ok",
  "service": "woohoo-server",
  "host": "127.0.0.1",
  "port": 8081,
  "baseUrl": "http://127.0.0.1:8081"
}
```

### `GET /api/ai/agents`

Returns static agent metadata plus live runtime fields:

```json
[
  {
    "id": "director",
    "name": "导演",
    "role": "统筹",
    "workCount": 12,
    "passRate": 0.92,
    "badge": "资深",
    "systemPrompt": "...",
    "status": "busy",
    "activeTasks": 2,
    "queuedTasks": 1
  }
]
```

`status` values:

- `idle`
- `queued`
- `busy`

### `POST /api/ai/tasks`

Creates an async AI task and immediately returns the queued task.

Request body:

```json
{
  "conversationId": "conv_xxx",
  "content": "@导演 给我出 3 个镜头版本",
  "agentId": "director",
  "endpointId": null,
  "model": null,
  "systemPrompt": null,
  "temperature": null,
  "maxTokens": null
}
```

Response status: `202 Accepted`

Response body:

```json
{
  "id": "task_xxx",
  "projectId": "proj_xxx",
  "conversationId": "conv_xxx",
  "agentId": "director",
  "content": "@导演 给我出 3 个镜头版本",
  "endpointId": "ep_xxx",
  "model": "gpt-4o-mini",
  "status": "queued",
  "result": null,
  "error": null,
  "createdAt": 1710000000000,
  "startedAt": null,
  "finishedAt": null
}
```

Behavior:

- The user message is persisted before the task is queued.
- The task is then scheduled into the runtime queue.
- When a worker slot is available, the task becomes `running`.
- On success, the assistant message is persisted and the task becomes `completed`.
- On failure, the task becomes `failed` and exposes the error in the task state.

### `GET /api/ai/tasks`

Returns the current in-memory task snapshot for the authenticated user.

Query parameters:

- `projectId` optional
- `conversationId` optional
- `limit` optional, default `50`, max `200`

### `GET /api/ai/tasks/:id`

Returns one task if it belongs to the authenticated user.

### `GET /api/ai/tasks/stream`

SSE subscription for task lifecycle events.

Supported query parameters:

- `projectId`
- `conversationId`
- `limit`

Event types:

- `snapshot`
- `queued`
- `running`
- `completed`
- `failed`
- `lagged`

`snapshot` payload:

```json
{
  "tasks": [
    {
      "id": "task_xxx",
      "status": "running"
    }
  ]
}
```

Lifecycle event payload:

```json
{
  "eventType": "completed",
  "task": {
    "id": "task_xxx",
    "status": "completed",
    "result": "..."
  }
}
```

`lagged` means the subscriber fell behind the broadcast buffer and should refresh from `GET /api/ai/tasks`.

## Compatibility Endpoints

These still exist and are still valid:

- `POST /api/ai/chat`
- `POST /api/ai/chat/stream`
- `POST /api/ai/test`

The sync and streaming chat paths were also tightened:

- User messages are now persisted before upstream AI execution.
- Refreshing after an upstream failure no longer drops the user prompt from server history.
- All sync chat, stream chat, async task execution, and endpoint test calls now write usage events to the backend usage ledger.

## API Usage Statistics

The backend now exposes a complete per-user AI usage ledger and aggregation API.

Tracked dimensions:

- Request count
- Success and failure count
- Latency
- Input and output character count
- Prompt, completion, and total tokens
- Token source: `actual`, `estimated`, or `unavailable`
- Breakdowns by endpoint, API key fingerprint, model, agent, project, operation, and resource kind
- Recent per-call records
- Retry cost and first-pass success cost

Tracked operations:

- `chat`
- `stream`
- `task`
- `test`

### Storage Model

Usage is persisted to the SQLite table `ai_usage_events`.

Each row stores:

- `userId`
- `projectId`
- `conversationId`
- `agentId`
- `endpointId`
- `apiKeyFingerprint`
- `provider`
- `model`
- `operation`
- `status`
- `resourceKind`
- `outputItems`
- `latencyMs`
- `promptTokens`
- `completionTokens`
- `totalTokens`
- `tokenSource`
- `inputChars`
- `outputChars`
- `requestFingerprint`
- `attemptGroupKey`
- `attemptIndex`
- `isRedo`
- `errorMessage`
- `createdAt`

This is independent from the `messages.token_usage` field, so the backend can report full API usage even when the conversation history is trimmed later.

### `GET /api/ai/usage/summary`

Returns an aggregated usage snapshot for the authenticated user.

Supported query parameters:

- `days` optional, default `30`, use `0` for all time, max `365`
- `bucket` optional: `hour`, `day`, `week`, or `month`
- `projectId` optional
- `conversationId` optional
- `agentId` optional
- `endpointId` optional
- `apiKeyFingerprint` optional
- `resourceKind` optional: `text`, `image`, `video`, `audio`, `document`, `other`
- `model` optional
- `operation` optional: `chat`, `stream`, `task`, `test`
- `status` optional: `success`, `failed`
- `limit` optional, affects embedded `recent` records, default `20`, max `200`

Response shape:

```json
{
  "window": {
    "from": "2026-04-01T00:00:00Z",
    "to": "2026-04-02T00:00:00Z",
    "days": 1,
    "bucket": "hour"
  },
  "totals": {
    "requestCount": 24,
    "successCount": 22,
    "failureCount": 2,
    "avgLatencyMs": 812,
    "maxLatencyMs": 4120,
    "outputItems": 22,
    "promptTokens": 18932,
    "completionTokens": 9261,
    "totalTokens": 28193,
    "actualTokenRecords": 18,
    "estimatedTokenRecords": 4,
    "unavailableTokenRecords": 2,
    "attemptGroupCount": 19,
    "redoRequestCount": 5,
    "redoTotalTokens": 6033,
    "firstPassSuccessCount": 17,
    "firstPassSuccessTokens": 19740,
    "retrySuccessCount": 5,
    "retrySuccessTokens": 6481
  },
  "series": [],
  "byEndpoint": [],
  "byApiKey": [],
  "byModel": [],
  "byAgent": [],
  "byProject": [],
  "byOperation": [],
  "byResourceKind": [],
  "recent": []
}
```

### `GET /api/ai/usage/records`

Returns recent per-call usage records with the same filter set as `summary`.

Each record is already joined with lightweight labels where available:

- `projectName`
- `agentName`
- `endpointName`

And now also includes:

- `apiKeyFingerprint`
- `resourceKind`
- `outputItems`
- `requestFingerprint`
- `attemptIndex`
- `isRedo`

This endpoint is the detailed drill-down view; `summary` is the dashboard view.

### Token Source Semantics

- `actual`: provider returned explicit token usage
- `estimated`: provider did not return usage, so the backend estimated from content length
- `unavailable`: the request failed before reliable token usage could be derived

For streaming calls, the backend currently records estimated usage because the outbound compatibility client does not rely on provider-specific stream-usage extensions.

### API Key Dimension

The backend does not expose raw API keys in usage analytics.

Instead it stores and filters by `apiKeyFingerprint`, which is a short one-way hash derived from the key material. This allows safe per-key aggregation without leaking credentials back to the frontend.

### Redo And First-Pass Metrics

The backend derives retry groups from normalized request content plus scope:

- user
- conversation or project scope
- agent
- operation
- resource kind

This powers:

- `redoRequestCount`
- `redoTotalTokens`
- `firstPassSuccessCount`
- `firstPassSuccessTokens`
- `retrySuccessCount`
- `retrySuccessTokens`

This is intended to answer questions like:

- how much consumption came from redoing the same request
- how much consumption landed on the first successful attempt
- how much consumption was spent after retries

## Workspace Bootstrap

`GET /api/workspace/bootstrap` now includes the live agent runtime fields:

- `status`
- `activeTasks`
- `queuedTasks`

The bootstrap path remains batch-loaded and is already optimized to avoid project/conversation/message N+1 queries.

## Frontend Wiring Still Needed

The backend is now ready for these frontend changes:

1. Submit async agent work to `POST /api/ai/tasks` instead of serializing all work through one local loading flag.
2. Open `EventSource` on `GET /api/ai/tasks/stream` and merge task updates into the chat/task panel.
3. Use `status`, `activeTasks`, and `queuedTasks` from `GET /api/ai/agents` or bootstrap to render live agent state.
4. Add `@agent` autocomplete and selection UI on top of the existing backend agent list.
5. Show task failure states from task objects rather than inferring failure only from chat history.

The frontend now also supports backend auto-discovery:

- Prefer `VITE_SERVER_BASE_URL` when explicitly configured.
- Otherwise probe localhost health checks across the server port window.
- Cache the last healthy backend base URL in local storage.

## Security Tightening

- AI endpoint list/create/update responses no longer return plaintext `apiKey` values to the frontend.
- Frontend endpoint reuse now matches on provider/base URL/model, and saving will update the matched backend endpoint in place.
- Registration now uses configurable bcrypt cost through `BCRYPT_COST` and defaults to `10`.
- Registration unique-key races now return `409 Conflict` instead of leaking through as `500`.

## Known Limitation

Task runtime state is process-local and in-memory.

That is enough for the current desktop/local deployment model and keeps the queue path fast, but if the product later needs multi-instance deployment or restart persistence, the next step is to move task state and pub/sub onto a durable store or broker.
