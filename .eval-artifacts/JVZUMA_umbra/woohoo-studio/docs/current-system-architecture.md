# Current System Architecture

## Overview

Woohoo Studio is a client-server application for AI-assisted video production. The frontend is a single-page React application; the backend is a Rust Axum HTTP API with SQLite persistence.

```
┌─────────────────────────────────────────────────┐
│                   Frontend                       │
│  React 18 + TypeScript + Vite + Arco + Zustand  │
├─────────────────────────────────────────────────┤
│  workspaceMvp/   - MVP workspace views & logic  │
│  Workspace/      - Main workspace components    │
│  assets/         - Asset repo & handlers        │
│  serverApi/      - API client layer             │
│  stores/         - Zustand state stores         │
│  components/     - Shared UI components         │
│  utils/          - Helpers (crypto, export, etc)│
└────────────────────┬────────────────────────────┘
                     │ HTTP / REST
┌────────────────────▼────────────────────────────┐
│                   Backend                        │
│          Rust Axum + SQLite + sqlx              │
├─────────────────────────────────────────────────┤
│  handlers/       - Route handlers               │
│  models/         - Data models & DB queries     │
│  migrations/     - SQL schema migrations        │
└─────────────────────────────────────────────────┘
```

## Data Model

### Core Entities

- **Project**: Top-level container with metadata (id, name, description, owner, timestamps).
- **Script**: Screenplay/scene text associated with a project. Has scenes, dialogue, action lines.
- **Storyboard (分镜)**: Sequence of shots, each with keyframe references, timing, camera notes.
- **Keyframe**: Individual frame images with metadata (asset reference, timestamp, annotations).
- **VideoPlan**: Pipeline configuration for video generation (model params, resolution, duration).
- **Asset**: Binary or reference to media file (images, audio, video, documents). Has id, name, type, url, size, checksum.
- **Session**: Editing session tracking changes over time.

### Export System

- `exportFullProjectBundle`: Creates a ZIP containing all project JSON data and downloaded asset files. Runs in the browser via JSZip.
- `exportCoreProjectBundle`: Creates a ZIP with scripts, storyboards, and treatment only (no binary assets).
- `createProjectSnapshot`: Captures current project state as a JSON snapshot object (used for undo/redo and versioning).
- Asset download: Individual asset streaming via `/api/assets/{id}/download`, bulk asset listing.

### State Management

Zustand stores manage:
- Workspace state (current project, active tab, selection)
- Asset repository (loaded assets, upload queue, download cache)
- Export state (export progress, last export result)

### API Endpoints (existing)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/projects | List projects |
| POST | /api/projects | Create project |
| GET | /api/projects/{id} | Get project detail |
| PUT | /api/projects/{id} | Update project |
| DELETE | /api/projects/{id} | Delete project |
| GET | /api/projects/{id}/scripts | Get scripts |
| POST | /api/projects/{id}/scripts | Create script |
| GET | /api/projects/{id}/storyboards | Get storyboards |
| GET | /api/projects/{id}/keyframes | Get keyframes |
| GET | /api/projects/{id}/video-plans | Get video plans |
| GET | /api/projects/{id}/assets | List assets |
| GET | /api/assets/{id}/download | Download asset file |
| POST | /api/assets | Upload asset |
| GET | /api/sessions | List sessions |

## Export Flow (Current)

1. User clicks "Export Full Project" or "Export Core Package" in the Workspace UI.
2. Frontend fetches all project data via serverApi calls.
3. Frontend downloads each asset as a Blob.
4. JSZip packages everything into a single .zip file.
5. Browser triggers download of the zip.

**Gaps (addressed by this update)**:
- No manifest file describing package contents
- No checksums for integrity verification
- No pre-export validation (missing assets, empty content, duplicate names)
- No reproducibility metadata (snapshot of state at export time)
- No sensitive data redaction
- No server-side audit trail
- No export history visible to users
