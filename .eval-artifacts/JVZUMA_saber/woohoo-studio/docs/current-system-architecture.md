# Current System Architecture

## Overview

Woohoo Studio is a web-based AI video production workspace. The architecture follows a standard client-server model with a React SPA frontend and Rust Axum backend.

## Frontend Architecture

### State Management
- **Zustand** stores manage workspace state, project data, user sessions
- Stores: workspaceStore, projectStore, assetStore, exportStore

### Key Modules

#### workspaceMvp/
Legacy MVP workspace components for quick project setup. Contains simplified editors used before the full workspace implementation.

#### Workspace/
Full production workspace with:
- Script editor panel
- Storyboard timeline
- Keyframe preview grid
- Video plan configuration
- Asset drag-and-drop handlers

#### assets/
Asset repository handlers:
- Upload/download progress tracking
- Asset preview (images, video thumbnails, audio)
- URL resolution and validation
- Duplicate filename detection

#### api/serverApi
Axios-based API client:
- Project CRUD
- Session management
- Script/storyboard/keyframe persistence
- Asset upload/download endpoints
- Export trigger endpoints

#### export/
Project export module (existing capabilities):
- `exportFullProjectBundle()` - creates ZIP with all project data and assets
- `exportCoreProjectBundle()` - creates ZIP with scripts, storyboards, planning docs only
- `createProjectSnapshot()` - serializes current workspace state to JSON

## Backend Architecture

### Axum Server
- REST API with JWT authentication
- SQLite database via sqlx
- Static file serving for uploaded assets

### Key Handlers
- Project handlers: CRUD, list, recent
- Asset handlers: upload, download, metadata, delete
- Export handlers: trigger export, list export history (NEW)
- Audit handlers: action logging, audit trail (NEW: export audit logs)

### Data Models
- `projects` - id, name, description, user_id, created_at, updated_at
- `scripts` - id, project_id, content, scene_index, metadata
- `storyboards` - id, project_id, scene_id, keyframe_url, notes
- `keyframes` - id, project_id, storyboard_id, image_url, prompt, parameters
- `video_plans` - id, project_id, settings, timeline_json
- `assets` - id, project_id, name, type, url, size_bytes, hash
- `sessions` - id, user_id, project_id, started_at
- **NEW** `export_audit_logs` - export history and integrity records

### API Endpoints (Current)
```
GET    /api/projects              List projects
POST   /api/projects              Create project
GET    /api/projects/:id          Get project with related data
PUT    /api/projects/:id          Update project
DELETE /api/projects/:id          Delete project

GET    /api/projects/:id/assets   List assets
POST   /api/assets/upload         Upload asset
GET    /api/assets/:id/download   Download asset

POST   /api/projects/:id/snapshot Create snapshot

NEW:
GET    /api/projects/:id/exports  List export audit history
POST   /api/exports/audit         Record export audit entry
GET    /api/exports/audit         List recent exports (admin/all)
```

## Export Flow (Before Enhancement)

1. User clicks "Export Full Project" in workspace
2. Frontend calls `exportFullProjectBundle()`:
   - Fetches all project data from API
   - Collects asset URLs
   - Downloads assets in parallel
   - Creates ZIP using JSZip
   - Triggers browser download
3. No manifest, no checksums, no preflight, no audit

## Export Flow (After Enhancement - this implementation)

1. User clicks export
2. **Preflight check** runs - validates scripts, storyboards, keyframes, assets, filenames
3. Results shown in modal: blocking issues prevent export (or require confirmation)
4. On confirmation:
   - Workspace snapshot serialized with sensitive fields stripped
   - Assets downloaded, SHA-256 computed for each file
   - `manifest.json` generated with file list, counts, asset status
   - `workspace_snapshot.json` with reproducible state
   - `README_EXPORT.md` with validation report
   - ZIP assembled and downloaded
   - Manifest hash sent to backend audit log API
5. Toast shows manifest hash, asset counts, missing count
6. Export history visible in workspace
