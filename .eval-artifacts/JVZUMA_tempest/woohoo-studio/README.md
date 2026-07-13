# Woohoo Studio

AI-powered video production workspace for script writing, storyboarding, keyframe generation, and video planning.

## Architecture

- **Frontend**: React 18 + TypeScript + Vite + Arco Design + Zustand
- **Backend**: Rust Axum + SQLite + sqlx
- **Core modules**: Workspace MVP, project management, script/storyboard/keyframe editors, asset repository, export pipeline

## Quick Start

```bash
# Frontend
cd frontend
npm install
npm run dev

# Backend
cd backend
cargo run
```

## Documentation

See [docs/current-system-architecture.md](docs/current-system-architecture.md) for system architecture details.

## Features

- Project/session/script/storyboard/keyframe/video-plan data model
- Asset repository with upload, download, preview
- Full project bundle export (complete project package)
- Core project bundle export (planning package only)
- Project snapshot creation
- **Export integrity verification, reproducible experiment packages & delivery audit** (new)
