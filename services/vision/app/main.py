from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException

from app.counter import CountSessionRequest, CountSessionResult, run_counting_session
from app.settings import get_settings

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="Session counting service for Trojan Traffic.",
)


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
