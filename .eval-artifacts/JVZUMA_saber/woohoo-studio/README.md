# Woohoo Studio

AI-powered video production workspace for scriptwriting, storyboarding, keyframe generation, and video planning.

## Tech Stack

**Frontend:** React 18 + TypeScript + Vite + Arco Design + Zustand
**Backend:** Rust Axum + SQLite + sqlx

## Project Structure

```
woohoo-studio/
├── frontend/           # React + Vite frontend
│   └── src/
│       ├── workspace/  # Workspace editors (scripts, storyboards, keyframes)
│       ├── workspaceMvp/ # MVP workspace components
│       ├── store/      # Zustand stores
│       ├── api/        # serverApi client
│       ├── assets/     # Asset handlers
│       └── export/     # Project export bundles
├── backend/            # Rust Axum server
│   └── src/
│       ├── handlers/   # API route handlers
│       ├── models/     # Data models
│       └── db/         # SQLite migrations and queries
└── docs/               # Documentation
```

## Development

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

## Features

- Script writing and management
- Storyboard/scene editing
- Keyframe management
- Video production planning
- Asset library and preview
- Project export (full bundle / core planning bundle)
- **NEW** Export package integrity validation, reproducible experiment bundles, delivery audit
