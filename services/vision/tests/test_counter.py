from datetime import UTC, datetime, timedelta
from threading import Event

import pytest

from app.counter import (
    CountSessionRequest,
    FrameObservation,
    Point,
    PolygonCrossingCounter,
    TrackObservation,
    run_counting_session,
)
from app.settings import Settings


def make_track(track_id: str, *, foot_x: float, foot_y: float) -> TrackObservation:
    width = 0.08
    height = 0.16
    return TrackObservation(
        id=track_id,
        x=foot_x - (width / 2),
        y=foot_y - height,
        width=width,
        height=height,
        confidence=0.9,
    )


def make_settings() -> Settings:
    return Settings(
        enable_live_detections=False,
        enable_auto_count_worker=False,
        count_entry_confirm_frames=1,
        count_exit_confirm_frames=1,
        supabase_url=None,
        supabase_service_role_key=None,
    )


def test_polygon_crossing_counter_counts_confirmed_footpoint_entry() -> None:
    polygon = [
        Point(x=0.4, y=0.4),
        Point(x=0.6, y=0.4),
        Point(x=0.6, y=0.6),
        Point(x=0.4, y=0.6),
    ]
    counter = PolygonCrossingCounter(polygon=polygon, entry_confirm_frames=1, exit_confirm_frames=1)

    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.32, foot_y=0.5)],
            count_enabled=True,
        )
        == 0
    )
    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.5, foot_y=0.5)],
            count_enabled=True,
        )
        == 1
    )
    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.52, foot_y=0.5)],
            count_enabled=True,
        )
        == 0
    )


def test_polygon_crossing_counter_does_not_count_track_that_starts_inside() -> None:
    polygon = [
        Point(x=0.4, y=0.4),
        Point(x=0.6, y=0.4),
        Point(x=0.6, y=0.6),
        Point(x=0.4, y=0.6),
    ]
    counter = PolygonCrossingCounter(polygon=polygon, entry_confirm_frames=1, exit_confirm_frames=1)

    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.5, foot_y=0.5)],
            count_enabled=True,
        )
        == 0
    )
    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.68, foot_y=0.5)],
            count_enabled=True,
        )
        == 0
    )
    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.5, foot_y=0.5)],
            count_enabled=True,
        )
        == 1
    )


def test_run_counting_session_counts_only_in_window_crossings() -> None:
    starts_at = datetime(2026, 3, 21, 12, 0, tzinfo=UTC)
    ends_at = starts_at + timedelta(seconds=30)
    payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=starts_at,
        ends_at=ends_at,
        region=[
            Point(x=0.4, y=0.4),
            Point(x=0.6, y=0.4),
            Point(x=0.6, y=0.6),
            Point(x=0.4, y=0.6),
        ],
    )
    observations = [
        FrameObservation(
            observed_at=starts_at - timedelta(seconds=2),
            tracks=(make_track("track-1", foot_x=0.32, foot_y=0.5),),
        ),
        FrameObservation(
            observed_at=starts_at + timedelta(seconds=1),
            tracks=(make_track("track-1", foot_x=0.5, foot_y=0.5),),
        ),
        FrameObservation(
            observed_at=starts_at + timedelta(seconds=3),
            tracks=(make_track("track-1", foot_x=0.52, foot_y=0.5),),
        ),
        FrameObservation(
            observed_at=ends_at + timedelta(seconds=1),
            tracks=(make_track("track-1", foot_x=0.68, foot_y=0.5),),
        ),
    ]

    result = run_counting_session(
        "session-123",
        payload,
        frame_observations=observations,
        settings=make_settings(),
    )

    assert result.status == "resolved"
    assert result.final_count == 1
    assert result.detections_processed == 2


def test_run_counting_session_rejects_starting_after_end_for_live_mode() -> None:
    now = datetime.now(UTC)
    payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=now - timedelta(seconds=30),
        ends_at=now - timedelta(seconds=1),
        region=[Point(x=0.1, y=0.1), Point(x=0.3, y=0.1), Point(x=0.2, y=0.3)],
    )

    with pytest.raises(ValueError):
        run_counting_session("session-123", payload, settings=make_settings())


def test_run_counting_session_rejects_live_mode_after_start_time() -> None:
    starts_at = datetime.now(UTC) - timedelta(seconds=2)
    payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=starts_at,
        ends_at=starts_at + timedelta(seconds=30),
        region=[Point(x=0.1, y=0.1), Point(x=0.3, y=0.1), Point(x=0.2, y=0.3)],
    )

    with pytest.raises(ValueError, match="must begin before the session window starts"):
        run_counting_session("session-late", payload, settings=make_settings())


def test_run_counting_session_returns_stopped_status_when_stop_requested() -> None:
    starts_at = datetime(2026, 3, 21, 12, 0, tzinfo=UTC)
    ends_at = starts_at + timedelta(seconds=30)
    payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=starts_at,
        ends_at=ends_at,
        region=[
            Point(x=0.4, y=0.4),
            Point(x=0.6, y=0.4),
            Point(x=0.6, y=0.6),
            Point(x=0.4, y=0.6),
        ],
    )
    stop_event = Event()
    stop_event.set()

    result = run_counting_session(
        "session-stop",
        payload,
        frame_observations=[
            FrameObservation(
                observed_at=starts_at + timedelta(seconds=1),
                tracks=(make_track("track-1", foot_x=0.5, foot_y=0.5),),
            )
        ],
        settings=make_settings(),
        stop_event=stop_event,
    )

    assert result.status == "stopped"
    assert result.final_count == 0
