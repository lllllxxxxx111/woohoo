# Backend Architecture Audit

## Active Backend

Current production-in-use backend root:

- `server/`

Current legacy / non-active backend:

- `backend/`

`server/` is the runtime actually started by the app and by `npm run dev:server`.
`backend/` is an older prototype tree and should be treated as archive candidate, not the source of truth.

## Current Backend Architecture

### Entry And Routing

- `server/src/main.rs`
  - environment loading
  - port failover
  - runtime manifest writing
  - route registration
  - auth middleware binding

### Core Runtime

- `server/src/db.rs`
  - SQLite pool
  - migration bootstrap
  - schema upgrades
  - default agent seeding
- `server/src/config.rs`
  - runtime config
- `server/src/error.rs`
  - shared error mapping

### Bounded Modules

- `server/src/auth`
  - register / login / me / JWT middleware
- `server/src/project`
  - project CRUD
- `server/src/conversation`
  - conversation CRUD
  - message CRUD
  - history queries
- `server/src/asset`
  - asset CRUD
- `server/src/script`
  - script CRUD
- `server/src/storyboard`
  - storyboard CRUD
- `server/src/workspace`
  - workspace bootstrap aggregation
- `server/src/ai`
  - endpoint management
  - agent management
  - sync chat
  - streaming chat
  - async task runtime
  - usage ledger and aggregation
  - local mock provider

## Canonical Data Ownership Model

The current active backend already uses the right top-level ownership shape:

- `users`
  - own `projects`
  - own `conversations`
  - own `ai_endpoints`
  - own `agents`
  - own `ai_usage_events`
- `projects`
  - own `conversations`
  - own `assets`
  - own `scripts`
  - own `storyboards`
- `conversations`
  - own `messages`

This is the right direction for keeping workspace data, AI configuration, and usage analytics isolated per user.

## Data Structure Cleanup Already Applied

### 1. User-scoped usage and frontend cache identity

The backend usage ledger already stores `user_id`, and usage reads are already filtered by `user_id`.

Additionally, the frontend now persists:

- server session with `userId`
- user-scoped local workspace cache
- user-scoped AI settings cache
- user-scoped endpoint binding cache

This avoids cross-account cache bleed on the same local machine.

### 2. Active backend config cleanup

Removed unused `REDIS_URL` from the active `server/` config surface.

Reason:

- task runtime is currently process-local and in-memory
- the active backend does not read or use Redis at runtime
- keeping the config field suggested a dependency that does not exist in the active path

## Things That Look Useless Or Misleading

### Safe conclusion

These are not part of the active runtime path:

- `backend/`
- `backend/target/`

Why:

- current frontend calls `server/` APIs
- current package scripts start `server/`
- active runtime contract and routes exist only in `server/`

### Recommended action

- archive or remove `backend/` after confirming no external scripts still depend on it
- remove `backend/target/` build artifacts first if you want the low-risk cleanup

### Not useless, keep them

- `server/src/ai/mock.rs`
  - useful for smoke tests and local no-quota verification
- `GET /health` runtime manifest / port failover path
  - required for current local multi-port startup behavior
- `server/src/ai/usage.rs`
  - central to usage cost tracking and should remain first-class

## Backend Complete, Frontend Not Fully Integrated

### Fully implemented in backend, not integrated into the main UX

1. Async AI task submission
   - Backend: `POST /api/ai/tasks`
   - Frontend status: main chat and pipeline steps do not submit work through this queue yet

2. Task detail fetch
   - Backend: `GET /api/ai/tasks/{id}`
   - Frontend status: no consumer found

3. Task SSE subscription
   - Backend: `GET /api/ai/tasks/stream`
   - Frontend status: no `EventSource` consumer found

4. Streaming chat transport
   - Backend: `POST /api/ai/chat/stream`
   - Frontend status: helper exists, but the main chat flow still uses sync chat

### Partially integrated

1. Task list
   - Backend: `GET /api/ai/tasks`
   - Frontend status:
     - used by `AutomationArea`
     - used by `PipelinePreview`
     - still polling-based
     - not wired into main chat orchestration

2. Live agent runtime fields
   - Backend returns `status`, `activeTasks`, `queuedTasks`
   - Frontend status:
     - settings table shows `status`
     - chat side panel still does not show real queue and active counts

3. Usage drill-down detail endpoint
   - Backend: `GET /api/ai/usage/records`
   - Frontend status:
     - dashboard currently uses `summary.recent`
     - no dedicated full drill-down view

## Frontend Placeholder Areas That Still Lack Real Backend Integration

These are not backend-done features. They are still mostly frontend placeholders:

- pipeline step pages under `src/components/Workspace/PipelineSteps`
- many actions still use `alert(...)` instead of task creation
- skills panel
- part of the automation control surface
- several settings panels marked as mock / not yet connected

This distinction matters:

- task runtime exists in backend
- pipeline generation workflow does not yet submit into it

## Practical Refactor Direction

If you want the backend architecture cleaner without changing product behavior, the next steps should be:

1. Treat `server/` as the only active backend root.
2. Archive or remove `backend/`.
3. Keep domain modules under `server/src/<module>/`.
4. Keep cross-cutting runtime pieces centralized in:
   - `config.rs`
   - `db.rs`
   - `error.rs`
   - `ai/runtime.rs`
   - `ai/usage.rs`
5. Keep user ownership mandatory in every write path and every aggregate query.

## Recommended Frontend Integration Order

1. Replace main chat single-flight flow with `POST /api/ai/tasks`.
2. Subscribe to `GET /api/ai/tasks/stream`.
3. Show task state directly in chat and automation panels.
4. Render real agent runtime counters in the chat side panel.
5. Convert pipeline step buttons from local alerts to real task submissions.
