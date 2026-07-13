# Current System Architecture

## Overview

Woohoo Studio is a full-stack AI video production workspace. The frontend is a React SPA that communicates with a Rust Axum backend via REST API. SQLite (via sqlx) is the primary data store.

## Frontend Architecture

### Tech Stack
- React 18 with TypeScript
- Vite for bundling/dev server
- Arco Design for UI components
- Zustand for client-side state management

### Key Directories
- `src/types/` — TypeScript type definitions for all domain models
- `src/store/` — Zustand stores (project store, workspace store, asset store)
- `src/api/` — serverApi wrappers for backend REST calls
- `src/workspaceMvp/` — MVP workspace module (scripts, storyboards, keyframes, video plans)
- `src/Workspace/` — Main workspace container, project layout
- `src/assetRepo/` — Asset repository handlers (upload, download, preview)
- `src/utils/` — Shared utilities including crypto, export helpers
- `src/components/` — Reusable UI components
- `src/hooks/` — Custom React hooks

### State Management
- `useProjectStore` — Current project metadata, sessions
- `useWorkspaceStore` — Scripts, storyboards, keyframes, video plans
- `useAssetStore` — Asset catalog, download status
- Export operations use browser-native APIs (Web Crypto for SHA-256, Blob/JSZip for packaging)

### Export Module (existing)
- `exportFullProjectBundle(project)` — Creates ZIP with all project data + assets
- `exportCoreProjectBundle(project)` — Creates ZIP with scripts/storyboards only (no heavy assets)
- `createProjectSnapshot(project)` — Captures a point-in-time JSON snapshot of project state
- Asset downloads are streamed and packed into the ZIP via JSZip

## Backend Architecture

### Tech Stack
- Rust with Axum web framework
- SQLite via sqlx (with compile-time query checking)
- Tower HTTP for middleware
- Serde for JSON serialization

### Key Directories
- `src/handlers/` — Request handlers grouped by domain (projects, assets, exports, etc.)
- `src/models/` — Database row types and API request/response types
- `src/db/` — Database initialization, migrations, connection pool
- `src/middleware/` — Auth, CORS, logging middleware

### API Surface
- `GET /api/projects` — List projects
- `POST /api/projects` — Create project
- `GET /api/projects/:id` — Get project detail (with scripts, storyboards, assets)
- `GET /api/assets/:id/download` — Download asset binary
- `POST /api/snapshots` — Create server-side snapshot
- `GET /api/projects/:id/exports` — List export audit history (new)
- `POST /api/exports/audit` — Record an export audit entry (new)

### Database Schema
- `projects` — id, name, description, created_at, updated_at, user_id
- `sessions` — id, project_id, name, created_at
- `scripts` — id, project_id, session_id, title, content, created_at
- `storyboards` — id, project_id, session_id, title, scenes_json, created_at
- `keyframes` — id, project_id, storyboard_id, asset_id, prompt, timestamp
- `video_plans` — id, project_id, session_id, config_json, created_at
- `assets` — id, project_id, name, asset_type, url, file_size, mime_type, created_at
- `export_audit_logs` — id, user_id, project_id, export_type, manifest_hash, asset_count, missing_asset_count, created_at (new)

## Data Flow

1. User opens workspace → frontend loads project via `GET /api/projects/:id`
2. User edits scripts/storyboards → Zustand stores update locally, debounced save to backend
3. User adds assets → upload to backend, stored in asset repo
4. User clicks export → frontend runs preflight checks, builds bundle with manifest/snapshot/report, downloads ZIP, then reports audit to backend
