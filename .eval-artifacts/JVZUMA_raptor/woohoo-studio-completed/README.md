# Woohoo Studio

AI-driven video & animation workspace for script-to-screen production pipelines.

## Stack

- **Frontend**: React 18 + TypeScript + Vite + Arco Design + Zustand
- **Backend**: Rust Axum + SQLite + sqlx
- **Key features**: Script writing, storyboard/keyframe editing, video planning, asset management, project export

## Quick Start

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Backend
```bash
cd backend
cargo run
```

## Architecture

See [docs/current-system-architecture.md](docs/current-system-architecture.md) for the full system architecture.

## Export System

The platform supports two primary export modes:

1. **Full Project Bundle** (`exportFullProjectBundle`): Exports all project data including scripts, storyboards, keyframes, video plans, and assets.
2. **Core Planning Package** (`exportCoreProjectBundle`): Exports only the creative planning documents (scripts, storyboards, treatment) without binary assets.

Additional export features:
- **Project Snapshots** (`createProjectSnapshot`): Point-in-time captures of project state.
- **Asset Download**: Individual and bulk asset retrieval.
- **Export Audit Log**: Server-side tracking of all exports for compliance and delivery verification.
- **Pre-export Validation**: Integrity checks before packaging to ensure completeness.
- **Manifest & Checksums**: SHA-256 verification for reproducible deliveries.
