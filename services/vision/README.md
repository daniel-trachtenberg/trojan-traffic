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
- `GET /detections/live`: latest detector metadata, frame ID, frame geometry, and person boxes
- `GET /detections/live/frame.jpg`: the exact JPEG frame that the latest boxes were produced from
- `POST /sessions/{session_id}/resolve`: write final count into Supabase via `resolve_session` RPC

The run endpoint is intentionally scaffold-level. It validates timing and payload shape but returns a
placeholder count so the web app and DB integration can be built in parallel.

The resolve endpoint requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.

The live detections endpoint requires `ENABLE_LIVE_DETECTIONS=true` and uses `CAMERA_PLAYLIST_URL`.

## Model choice

For this repo's current CPU-based live service, the default is now `YOLO11s` with explicit input
resolution and conservative NMS.

- On sampled USC night frames, `YOLO11s` produced materially fewer false positives than the
  repo's earlier `RT-DETR-L` path while running much faster on CPU.
- The detector now passes an explicit `imgsz` into Ultralytics instead of relying on the smaller
  default inference size, which was dropping distant pedestrians.
- The service keeps track state internally, but it no longer renders unmatched stale tracks back to
  the frontend. That removes the "ghost boxes" lag that appeared when a detection briefly disappeared.

## Frontend sync

The frontend should render `/detections/live/frame.jpg?frame_id=...` when live detections are
enabled, instead of trying to align boxes to a separate HLS playback buffer. The frame endpoint is
the same image the detector used for the returned boxes, so the overlay stays synchronized.

## Tuning detection quality

For the USC traffic camera, the current defaults are tuned for small pedestrians on a static,
nighttime full-frame view:

- `DETECTION_MODEL_NAME=yolo11s.pt`
- `DETECTION_CONFIDENCE=0.30`
- `DETECTION_INTERVAL_MS=600`
- `DETECTION_STREAM_MAX_WIDTH=1280`
- `DETECTION_MODEL_INPUT_SIZE=1280`
- `DETECTION_NMS_IOU=0.45`
- `DETECTION_REGION_LEFT=0.00`
- `DETECTION_REGION_TOP=0.00`
- `DETECTION_REGION_RIGHT=1.00`
- `DETECTION_REGION_BOTTOM=1.00`
- `DETECTION_MIN_BOX_AREA_RATIO=0.00012`
- `DETECTION_MIN_BOX_HEIGHT_RATIO=0.022`
- `DETECTION_MIN_BOX_ASPECT_RATIO=1.2`
- `DETECTION_MAX_BOX_ASPECT_RATIO=6.0`
- `DETECTION_MIN_TRACK_HITS=1`

This path is intentionally full-frame. It favors reliable person boxes over trying to crop the
scene aggressively and missing distant walkers.

The region values are normalized coordinates on the full frame. The detector now looks across the
entire frame and filters candidates by size and person-like aspect ratio before assigning stable IDs.
