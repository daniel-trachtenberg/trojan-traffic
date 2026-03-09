from datetime import UTC, datetime, timedelta

import pytest

from app.counter import CountSessionRequest, Point, run_counting_session


def test_run_counting_session_returns_scaffold_payload() -> None:
    now = datetime.now(UTC)
    payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=now - timedelta(seconds=60),
        ends_at=now - timedelta(seconds=30),
        region=[Point(x=1, y=1), Point(x=120, y=1), Point(x=120, y=120), Point(x=1, y=120)],
    )

    result = run_counting_session("session-123", payload)
    assert result.status == "resolved"
    assert result.final_count == 0


def test_run_counting_session_rejects_future_end_time() -> None:
    now = datetime.now(UTC)
    payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=now,
        ends_at=now + timedelta(seconds=15),
        region=[Point(x=1, y=1), Point(x=120, y=1), Point(x=120, y=120)],
    )

    with pytest.raises(ValueError):
        run_counting_session("session-123", payload)
