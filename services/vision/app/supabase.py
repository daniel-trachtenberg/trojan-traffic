import httpx

from app.settings import get_settings


async def resolve_session_in_supabase(session_id: str, final_count: int) -> int:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise RuntimeError("Supabase service credentials are not configured.")

    headers = {
        "apikey": settings.supabase_service_role_key,
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "p_session_id": session_id,
        "p_final_count": final_count,
    }

    endpoint = f"{str(settings.supabase_url).rstrip('/')}/rest/v1/rpc/resolve_session"

    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(endpoint, headers=headers, json=payload)
        response.raise_for_status()

    data = response.json()
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            processed_predictions = first.get("processed_predictions")
            if isinstance(processed_predictions, int):
                return processed_predictions

    raise RuntimeError("Unexpected response shape from Supabase resolve_session RPC.")
