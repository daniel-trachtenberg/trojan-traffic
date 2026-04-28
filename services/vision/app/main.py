from datetime import UTC, datetime

import httpx
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.counter import CountSessionRequest, CountSessionResult, run_counting_session
from app.detector import LivePersonDetector
from app.session_worker import AutomaticCountingWorker
from app.settings import get_settings
from app.supabase import resolve_session_in_supabase

settings = get_settings()
LIVE_DETECTION_PREVIEW_ENABLED = True

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="Session counting service for Trojan Traffic.",
)

if settings.cors_origins.strip() == "*":
    allow_origins = ["*"]
else:
    allow_origins = [
        origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

person_detector: LivePersonDetector | None = None
session_worker: AutomaticCountingWorker | None = None


class ResolveSessionRequest(BaseModel):
    final_count: int = Field(ge=0)


class ResolveSessionResponse(BaseModel):
    session_id: str
    final_count: int = Field(ge=0)
    processed_predictions: int = Field(ge=0)
    resolved_at: str


class PersonDetectionBox(BaseModel):
    id: str
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(ge=0, le=1)
    height: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)


class LiveDetectionsResponse(BaseModel):
    status: str
    source_url: str
    updated_at: str | None
    processing_ms: float | None
    server_now: str
    frame_id: str | None
    frame_width: int | None = Field(default=None, ge=1)
    frame_height: int | None = Field(default=None, ge=1)
    boxes: list[PersonDetectionBox]


@app.on_event("startup")
def startup_event() -> None:
    global person_detector, session_worker
    if LIVE_DETECTION_PREVIEW_ENABLED and settings.enable_live_detections:
        person_detector = LivePersonDetector(
            source_url=str(settings.camera_playlist_url),
            model_name=settings.detection_model_name,
            confidence=settings.detection_confidence,
            interval_ms=settings.detection_interval_ms,
            stream_max_width=settings.detection_stream_max_width,
            model_input_size=settings.detection_model_input_size,
            nms_iou=settings.detection_nms_iou,
            region_left=settings.detection_region_left,
            region_top=settings.detection_region_top,
            region_right=settings.detection_region_right,
            region_bottom=settings.detection_region_bottom,
            min_box_area_ratio=settings.detection_min_box_area_ratio,
            min_box_height_ratio=settings.detection_min_box_height_ratio,
            min_box_aspect_ratio=settings.detection_min_box_aspect_ratio,
            max_box_aspect_ratio=settings.detection_max_box_aspect_ratio,
            min_track_hits=settings.detection_min_track_hits,
            reconnect_delay_ms=settings.detection_reconnect_delay_ms,
            max_boxes=settings.detection_max_boxes,
        )
        person_detector.start()

    if (
        settings.enable_auto_count_worker
        and settings.supabase_url
        and settings.supabase_service_role_key
    ):
        session_worker = AutomaticCountingWorker(settings=settings)
        session_worker.start()


@app.on_event("shutdown")
def shutdown_event() -> None:
    if session_worker is not None:
        session_worker.stop()

    if person_detector is None:
        return

    person_detector.stop()


@app.get("/health")
def healthcheck() -> dict[str, str]:
    return {
        "service": settings.app_name,
        "status": "ok",
        "timestamp": datetime.now(UTC).isoformat(),
    }


@app.post("/sessions/{session_id}/run", response_model=CountSessionResult)
def run_session(session_id: str, payload: CountSessionRequest) -> CountSessionResult:
    try:
        return run_counting_session(session_id=session_id, payload=payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/detections/live", response_model=LiveDetectionsResponse)
def get_live_detections() -> LiveDetectionsResponse:
    if person_detector is None:
        raise HTTPException(status_code=503, detail="Live detector is not enabled.")

    snapshot = person_detector.get_snapshot()
    server_now = datetime.now(UTC).isoformat()
    return LiveDetectionsResponse(
        status=snapshot.status,
        source_url=snapshot.source_url,
        updated_at=snapshot.updated_at,
        processing_ms=snapshot.processing_ms,
        server_now=server_now,
        frame_id=snapshot.frame_id,
        frame_width=snapshot.frame_width,
        frame_height=snapshot.frame_height,
        boxes=[PersonDetectionBox.model_validate(box) for box in snapshot.boxes],
    )


@app.get("/detections/live/frame.jpg")
def get_live_detection_frame(frame_id: str | None = None) -> Response:
    if person_detector is None:
        raise HTTPException(status_code=503, detail="Live detector is not enabled.")

    frame_jpeg = person_detector.get_frame_jpeg(frame_id=frame_id)
    if frame_jpeg is None:
        raise HTTPException(status_code=404, detail="Live detector frame is not available.")

    return Response(
        content=frame_jpeg,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
        },
    )


@app.post("/sessions/{session_id}/resolve", response_model=ResolveSessionResponse)
async def resolve_session(
    session_id: str, payload: ResolveSessionRequest
) -> ResolveSessionResponse:
    try:
        processed_predictions = await resolve_session_in_supabase(
            session_id=session_id,
            final_count=payload.final_count,
        )
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"Supabase RPC failed: {exc.response.text}",
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return ResolveSessionResponse(
        session_id=session_id,
        final_count=payload.final_count,
        processed_predictions=processed_predictions,
        resolved_at=datetime.now(UTC).isoformat(),
    )
