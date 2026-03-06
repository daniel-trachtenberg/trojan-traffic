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

`ffmpeg` is required for live detections because the service snapshots frames from HLS.

## Current endpoints

- `GET /health`: health check
- `POST /sessions/{session_id}/run`: run a stub counting session with typed payload
- `GET /detections/live`: latest person boxes from YOLO detector loop
- `POST /sessions/{session_id}/resolve`: write final count into Supabase via `resolve_session` RPC

The run endpoint is intentionally scaffold-level. It validates timing and payload shape but returns a
placeholder count so the web app and DB integration can be built in parallel.

The resolve endpoint requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.

The live detections endpoint requires `ENABLE_LIVE_DETECTIONS=true` and uses `CAMERA_PLAYLIST_URL`.
