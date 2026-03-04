# Vision Service

FastAPI service that will run person detection/tracking and write finalized counts for each betting
session.

## Run locally

```bash
cd services/vision
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8080
```

## Current endpoints

- `GET /health`: health check
- `POST /sessions/{session_id}/run`: run a stub counting session with typed payload

The run endpoint is intentionally scaffold-level. It validates timing and payload shape but returns a
placeholder count so the web app and DB integration can be built in parallel.
