from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
from pydantic import BaseModel, Field, HttpUrl

from app.settings import get_settings


class SessionRegionPoint(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class PendingSessionRecord(BaseModel):
    id: str
    starts_at: datetime
    ends_at: datetime
    status: str
    camera_feed_url: HttpUrl
    region_polygon: list[SessionRegionPoint] = Field(min_length=2)
    final_count: int | None = None
    resolved_at: datetime | None = None


def _build_headers() -> dict[str, str]:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise RuntimeError("Supabase service credentials are not configured.")

    return {
        "apikey": settings.supabase_service_role_key,
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "Content-Type": "application/json",
    }


def _build_rest_endpoint(path: str) -> str:
    settings = get_settings()
    if not settings.supabase_url:
        raise RuntimeError("Supabase URL is not configured.")

    return f"{str(settings.supabase_url).rstrip('/')}{path}"


def _parse_processed_predictions(data: object) -> int:
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            processed_predictions = first.get("processed_predictions")
            if isinstance(processed_predictions, int):
                return processed_predictions

    raise RuntimeError("Unexpected response shape from Supabase resolve_session RPC.")


async def resolve_session_in_supabase(session_id: str, final_count: int) -> int:
    headers = _build_headers()
    payload = {
        "p_session_id": session_id,
        "p_final_count": final_count,
    }
    endpoint = _build_rest_endpoint("/rest/v1/rpc/resolve_session")

    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(endpoint, headers=headers, json=payload)
        response.raise_for_status()

    return _parse_processed_predictions(response.json())


def resolve_session_in_supabase_sync(session_id: str, final_count: int) -> int:
    headers = _build_headers()
    payload = {
        "p_session_id": session_id,
        "p_final_count": final_count,
    }
    endpoint = _build_rest_endpoint("/rest/v1/rpc/resolve_session")

    with httpx.Client(timeout=20.0) as client:
        response = client.post(endpoint, headers=headers, json=payload)
        response.raise_for_status()

    return _parse_processed_predictions(response.json())


def list_countable_sessions(
    *,
    now: datetime | None = None,
    lookahead_ms: int,
    limit: int = 12,
) -> list[PendingSessionRecord]:
    resolved_now = now or datetime.now(UTC)
    upper_bound = resolved_now + timedelta(milliseconds=max(lookahead_ms, 0))
    endpoint = _build_rest_endpoint("/rest/v1/game_sessions")
    headers = _build_headers()
    params = {
        "select": (
            "id,starts_at,ends_at,status,camera_feed_url,"
            "region_polygon,final_count,resolved_at"
        ),
        "status": "not.in.(resolved,cancelled)",
        "resolved_at": "is.null",
        "starts_at": f"lte.{upper_bound.isoformat()}",
        "ends_at": f"gt.{resolved_now.isoformat()}",
        "order": "starts_at.asc",
        "limit": str(max(limit, 1)),
    }

    with httpx.Client(timeout=20.0) as client:
        response = client.get(endpoint, headers=headers, params=params)
        response.raise_for_status()

    payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError("Unexpected response shape from Supabase game_sessions query.")

    sessions: list[PendingSessionRecord] = []
    for item in payload:
        sessions.append(PendingSessionRecord.model_validate(item))
    return sessions
