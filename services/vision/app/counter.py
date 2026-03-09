from collections.abc import Sequence
from datetime import UTC, datetime

from pydantic import BaseModel, Field, HttpUrl


class Point(BaseModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)


class CountSessionRequest(BaseModel):
    feed_url: HttpUrl
    starts_at: datetime
    ends_at: datetime
    region: Sequence[Point] = Field(min_length=3)


class CountSessionResult(BaseModel):
    session_id: str
    status: str
    final_count: int = Field(ge=0)
    detections_processed: int = Field(ge=0)
    started_at: datetime
    ended_at: datetime
    notes: str


def run_counting_session(session_id: str, payload: CountSessionRequest) -> CountSessionResult:
    if payload.ends_at <= payload.starts_at:
        raise ValueError("Session end time must be after start time.")

    now = datetime.now(UTC)
    if payload.ends_at > now:
        raise ValueError("Session cannot be resolved before its end time.")

    return CountSessionResult(
        session_id=session_id,
        status="resolved",
        final_count=0,
        detections_processed=0,
        started_at=payload.starts_at,
        ended_at=payload.ends_at,
        notes=(
            "Scaffold result. Replace with actual HLS ingestion, tracking IDs, "
            "and polygon entry counting."
        ),
    )
