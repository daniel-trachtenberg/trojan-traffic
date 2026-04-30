from datetime import UTC, datetime, timedelta
from threading import Event

import numpy as np
import pytest

from app.counter import (
    CountSessionRequest,
    FrameObservation,
    LineCrossingCounter,
    LiveSessionTrackSource,
    Point,
    PolygonCrossingCounter,
    RawDetection,
    TrackObservation,
    get_region_scan_bounds,
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


def make_box(
    track_id: str,
    *,
    x: float,
    y: float,
    width: float = 0.08,
    height: float = 0.16,
) -> TrackObservation:
    return TrackObservation(
        id=track_id,
        x=x,
        y=y,
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


def test_line_crossing_counter_counts_confirmed_crossing_in_either_direction() -> None:
    counter = LineCrossingCounter(
        line_start=Point(x=0.5, y=0.3),
        line_end=Point(x=0.5, y=0.7),
        cooldown_frames=1,
    )

    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.4, foot_y=0.5)],
            count_enabled=True,
        )
        == 0
    )
    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.6, foot_y=0.5)],
            count_enabled=True,
        )
        == 1
    )
    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.4, foot_y=0.5)],
            count_enabled=True,
        )
        == 1
    )


def test_line_crossing_counter_does_not_count_track_that_starts_on_line() -> None:
    counter = LineCrossingCounter(
        line_start=Point(x=0.5, y=0.3),
        line_end=Point(x=0.5, y=0.7),
        cooldown_frames=1,
    )

    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.5, foot_y=0.5)],
            count_enabled=True,
        )
        == 0
    )
    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.6, foot_y=0.5)],
            count_enabled=True,
        )
        == 0
    )


def test_line_crossing_counter_counts_visual_body_crossing_when_feet_stay_below_line() -> None:
    counter = LineCrossingCounter(
        line_start=Point(x=0.4, y=0.5),
        line_end=Point(x=0.6, y=0.5),
        cooldown_frames=1,
    )

    assert (
        counter.observe_tracks(
            [make_box("track-1", x=0.46, y=0.38)],
            count_enabled=True,
        )
        == 0
    )
    assert (
        counter.observe_tracks(
            [make_box("track-1", x=0.46, y=0.46)],
            count_enabled=True,
        )
        == 1
    )


def test_line_crossing_counter_allows_small_endpoint_miss() -> None:
    counter = LineCrossingCounter(
        line_start=Point(x=0.5, y=0.4),
        line_end=Point(x=0.5, y=0.6),
        cooldown_frames=1,
    )

    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.45, foot_y=0.63)],
            count_enabled=True,
        )
        == 0
    )
    assert (
        counter.observe_tracks(
            [make_track("track-1", foot_x=0.55, foot_y=0.63)],
            count_enabled=True,
        )
        == 1
    )


def test_live_track_source_keeps_ids_for_sparse_crossing_frames() -> None:
    source = object.__new__(LiveSessionTrackSource)
    source._tracks = {}
    source._frame_index = 0

    source._frame_index += 1
    first_tracks = source._assign_tracks(
        [RawDetection(x1=100, y1=100, x2=116, y2=150, confidence=0.82)]
    )
    source._frame_index += 1
    second_tracks = source._assign_tracks(
        [RawDetection(x1=126, y1=100, x2=142, y2=150, confidence=0.84)]
    )

    assert len(first_tracks) == 1
    assert len(second_tracks) == 1
    assert second_tracks[0].id == first_tracks[0].id
    assert second_tracks[0].hits == 2


def test_recorded_counting_uses_denser_sampling_interval() -> None:
    source = object.__new__(LiveSessionTrackSource)
    source._settings = Settings(
        count_process_after_session=True,
        count_frame_sample_interval_ms=200,
    )

    assert source._frame_sample_interval_ms() == 200
    assert source._frame_sample_fps() == pytest.approx(5.0)


def test_counting_stream_capture_uses_short_prewarm_window() -> None:
    starts_at = datetime(2026, 3, 21, 12, 0, tzinfo=UTC)
    source = object.__new__(LiveSessionTrackSource)
    source._settings = Settings(count_prewarm_seconds=8)
    source._payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=starts_at,
        ends_at=starts_at + timedelta(seconds=30),
        region=[
            Point(x=0.5, y=0.3),
            Point(x=0.5, y=0.7),
        ],
    )

    assert source._capture_start_at() == starts_at - timedelta(seconds=8)


def test_recorded_frames_are_jpeg_encoded_to_limit_memory() -> None:
    source = object.__new__(LiveSessionTrackSource)
    source._session_id = "session-record"
    source._settings = Settings(
        count_process_after_session=True,
        count_recorded_frame_jpeg_quality=92,
    )
    frame = np.zeros((24, 32, 3), dtype=np.uint8)
    frame[:, :, 1] = 180

    observation = source._make_frame_observation(
        observed_at=datetime(2026, 3, 21, 12, 0, tzinfo=UTC),
        frame=frame,
    )
    decoded = observation.decode_frame()

    assert observation.frame is None
    assert observation.encoded_jpeg
    assert decoded is not None
    assert decoded.shape == frame.shape


def test_get_region_scan_bounds_adds_padding_around_polygon() -> None:
    bounds = get_region_scan_bounds(
        [
            Point(x=0.45, y=0.44),
            Point(x=0.59, y=0.44),
            Point(x=0.61, y=0.58),
            Point(x=0.46, y=0.57),
        ],
        padding_x=0.04,
        padding_y=0.06,
    )

    assert bounds.left == pytest.approx(0.41)
    assert bounds.top == pytest.approx(0.38)
    assert bounds.right == pytest.approx(0.65)
    assert bounds.bottom == pytest.approx(0.64)


def test_run_counting_session_counts_only_in_window_crossings() -> None:
    starts_at = datetime(2026, 3, 21, 12, 0, tzinfo=UTC)
    ends_at = starts_at + timedelta(seconds=30)
    payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=starts_at,
        ends_at=ends_at,
        region=[
            Point(x=0.5, y=0.3),
            Point(x=0.5, y=0.7),
        ],
    )
    observations = [
        FrameObservation(
            observed_at=starts_at - timedelta(seconds=2),
            tracks=(make_track("track-1", foot_x=0.4, foot_y=0.5),),
        ),
        FrameObservation(
            observed_at=starts_at + timedelta(seconds=1),
            tracks=(make_track("track-1", foot_x=0.6, foot_y=0.5),),
        ),
        FrameObservation(
            observed_at=starts_at + timedelta(seconds=3),
            tracks=(make_track("track-1", foot_x=0.62, foot_y=0.5),),
        ),
        FrameObservation(
            observed_at=ends_at + timedelta(seconds=1),
            tracks=(make_track("track-1", foot_x=0.4, foot_y=0.5),),
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
    assert "crossings across the line" in result.notes


def test_run_counting_session_uses_configured_line_cooldown() -> None:
    starts_at = datetime(2026, 3, 21, 12, 0, tzinfo=UTC)
    ends_at = starts_at + timedelta(seconds=30)
    payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=starts_at,
        ends_at=ends_at,
        region=[
            Point(x=0.5, y=0.3),
            Point(x=0.5, y=0.7),
        ],
    )

    result = run_counting_session(
        "session-cooldown",
        payload,
        frame_observations=[
            FrameObservation(
                observed_at=starts_at + timedelta(seconds=1),
                tracks=(make_track("track-1", foot_x=0.4, foot_y=0.5),),
            ),
            FrameObservation(
                observed_at=starts_at + timedelta(seconds=2),
                tracks=(make_track("track-1", foot_x=0.6, foot_y=0.5),),
            ),
            FrameObservation(
                observed_at=starts_at + timedelta(seconds=3),
                tracks=(make_track("track-1", foot_x=0.4, foot_y=0.5),),
            ),
        ],
        settings=Settings(
            enable_live_detections=False,
            enable_auto_count_worker=False,
            count_entry_confirm_frames=1,
            count_line_cooldown_frames=10,
            supabase_url=None,
            supabase_service_role_key=None,
        ),
    )

    assert result.final_count == 1


def test_run_counting_session_emits_live_count_updates() -> None:
    starts_at = datetime(2026, 3, 21, 12, 0, tzinfo=UTC)
    ends_at = starts_at + timedelta(seconds=30)
    payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=starts_at,
        ends_at=ends_at,
        region=[
            Point(x=0.5, y=0.3),
            Point(x=0.5, y=0.7),
        ],
    )
    updates: list[int] = []

    result = run_counting_session(
        "session-123",
        payload,
        frame_observations=[
            FrameObservation(
                observed_at=starts_at + timedelta(seconds=1),
                tracks=(make_track("track-1", foot_x=0.4, foot_y=0.5),),
            ),
            FrameObservation(
                observed_at=starts_at + timedelta(seconds=2),
                tracks=(make_track("track-1", foot_x=0.6, foot_y=0.5),),
            ),
        ],
        settings=make_settings(),
        count_update_handler=updates.append,
    )

    assert result.final_count == 1
    assert updates == [0, 1]


def test_run_counting_session_resumes_from_initial_count() -> None:
    starts_at = datetime(2026, 3, 21, 12, 0, tzinfo=UTC)
    ends_at = starts_at + timedelta(seconds=30)
    payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=starts_at,
        ends_at=ends_at,
        region=[
            Point(x=0.5, y=0.3),
            Point(x=0.5, y=0.7),
        ],
    )
    updates: list[int] = []

    result = run_counting_session(
        "session-resume",
        payload,
        frame_observations=[
            FrameObservation(
                observed_at=starts_at + timedelta(seconds=1),
                tracks=(make_track("track-1", foot_x=0.4, foot_y=0.5),),
            ),
            FrameObservation(
                observed_at=starts_at + timedelta(seconds=2),
                tracks=(make_track("track-1", foot_x=0.6, foot_y=0.5),),
            ),
        ],
        settings=make_settings(),
        initial_count=4,
        count_update_handler=updates.append,
    )

    assert result.final_count == 5
    assert updates == [4, 5]


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


def test_run_counting_session_rejects_live_mode_after_end_time() -> None:
    now = datetime.now(UTC)
    payload = CountSessionRequest(
        feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        starts_at=now - timedelta(seconds=32),
        ends_at=now - timedelta(seconds=2),
        region=[Point(x=0.1, y=0.1), Point(x=0.3, y=0.1), Point(x=0.2, y=0.3)],
    )

    with pytest.raises(ValueError, match="must be counted before its end time"):
        run_counting_session("session-ended", payload, settings=make_settings())


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
