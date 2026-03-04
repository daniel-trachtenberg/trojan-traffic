from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from app.counter import CountSessionRequest, CountSessionResult, run_counting_session
from app.settings import get_settings
from app.supabase import resolve_session_in_supabase

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="Session counting service for Trojan Traffic.",
)


class ResolveSessionRequest(BaseModel):
    final_count: int = Field(ge=0)


class ResolveSessionResponse(BaseModel):
    session_id: str
    final_count: int = Field(ge=0)
    processed_predictions: int = Field(ge=0)
    resolved_at: str


@app.get("/health")
def healthcheck() -> dict[str, str]:
    return {
        "service": settings.app_name,
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/sessions/{session_id}/run", response_model=CountSessionResult)
def run_session(session_id: str, payload: CountSessionRequest) -> CountSessionResult:
    try:
        return run_counting_session(session_id=session_id, payload=payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/sessions/{session_id}/resolve", response_model=ResolveSessionResponse)
async def resolve_session(session_id: str, payload: ResolveSessionRequest) -> ResolveSessionResponse:
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
        resolved_at=datetime.now(timezone.utc).isoformat(),
    )
