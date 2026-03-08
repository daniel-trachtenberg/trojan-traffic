# Vision Service

FastAPI service that will run person detection/tracking and write finalized counts for each betting
session.

## Run locally

```bash
cd services/vision
rm -rf .venv
"/usr/local/opt/python@3.12/bin/python3.12" -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
python -m pip install -e ".[dev]"
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8080
```

If you already created the venv before the NumPy/OpenCV pin, rebuild it instead of trying to patch
packages in place:

```bash
rm -rf .venv
"/usr/local/opt/python@3.12/bin/python3.12" -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
python -m pip install -e ".[dev]"
```

`ffmpeg` and `ffprobe` are required for live detections because the service reads the HLS stream
continuously and tracks people across successive frames.

## Current endpoints

- `GET /health`: health check
- `POST /sessions/{session_id}/run`: run a stub counting session with typed payload
- `GET /detections/live`: latest person boxes from YOLO detector loop
- `POST /sessions/{session_id}/resolve`: write final count into Supabase via `resolve_session` RPC

The run endpoint is intentionally scaffold-level. It validates timing and payload shape but returns a
placeholder count so the web app and DB integration can be built in parallel.

The resolve endpoint requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.

The live detections endpoint requires `ENABLE_LIVE_DETECTIONS=true` and uses `CAMERA_PLAYLIST_URL`.

## Model choice

For this repo's current CPU-based live service, the higher-recall default is now `RT-DETR-L` with a
simple IoU tracker.

- `RT-DETR-L` detected more pedestrians on the full frame than the YOLO variants tested in this
  repo.
- Ultralytics' built-in `track()` path dropped valid full-frame detections for this camera, so the
  service now uses `predict()` plus a lightweight IoU-based tracker to preserve recall.

## Tuning detection quality

For the USC traffic camera, small distant pedestrians were missed when the service used a narrower
ROI and a lighter detector. The defaults now favor full-frame recall:

- `DETECTION_MODEL_NAME=rtdetr-l.pt`
- `DETECTION_CONFIDENCE=0.18`
- `DETECTION_INTERVAL_MS=1800`
- `DETECTION_STREAM_MAX_WIDTH=1920`
- `DETECTION_REGION_LEFT=0.00`
- `DETECTION_REGION_TOP=0.00`
- `DETECTION_REGION_RIGHT=1.00`
- `DETECTION_REGION_BOTTOM=1.00`
- `DETECTION_MIN_BOX_AREA_RATIO=0.00015`
- `DETECTION_MIN_BOX_HEIGHT_RATIO=0.025`
- `DETECTION_MIN_BOX_ASPECT_RATIO=1.2`
- `DETECTION_MAX_BOX_ASPECT_RATIO=6.0`
- `DETECTION_MIN_TRACK_HITS=1`

This is the higher-recall path. It is slower on CPU than the earlier YOLO setup, but it is the
better choice if missing pedestrians is a worse failure than slower updates.

The region values are normalized coordinates on the full frame. The detector now looks across the
entire frame and filters candidates by size and person-like aspect ratio before assigning stable IDs.
