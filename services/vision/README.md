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

## Tuning detection quality

For the USC traffic camera, small distant pedestrians were missed when the stream was downscaled too
aggressively. The defaults now favor recall:

- `DETECTION_MODEL_NAME=yolov8s.pt`
- `DETECTION_CONFIDENCE=0.15`
- `DETECTION_STREAM_MAX_WIDTH=1920`
- `DETECTION_REGION_LEFT=0.78`
- `DETECTION_REGION_TOP=0.45`
- `DETECTION_REGION_RIGHT=0.90`
- `DETECTION_REGION_BOTTOM=0.55`
- `DETECTION_MIN_BOX_AREA_RATIO=0.0002`
- `DETECTION_MIN_BOX_HEIGHT_RATIO=0.04`
- `DETECTION_MIN_BOX_ASPECT_RATIO=1.4`
- `DETECTION_MAX_BOX_ASPECT_RATIO=5.5`
- `DETECTION_MIN_TRACK_HITS=1`

If tracking is too slow on your machine, reduce `DETECTION_STREAM_MAX_WIDTH` first before swapping
back to a smaller model.

The region values are normalized coordinates on the full frame. The detector now focuses on the
right-side walkway section and filters candidates by size and person-like aspect ratio.
