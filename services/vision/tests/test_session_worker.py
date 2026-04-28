from datetime import UTC, datetime, timedelta
from threading import Event

from app.counter import CountSessionResult
from app.session_worker import AutomaticCountingWorker
from app.settings import Settings
from app.supabase import PendingSessionRecord, SessionRegionPoint


def make_settings() -> Settings:
    return Settings(
        enable_live_detections=False,
        enable_auto_count_worker=True,
        auto_count_poll_interval_ms=50,
        auto_count_session_lookahead_ms=5000,
        supabase_url=None,
        supabase_service_role_key=None,
    )


def test_worker_avoids_duplicate_in_process_jobs() -> None:
    starts_at = datetime.now(UTC) + timedelta(seconds=1)
    session = PendingSessionRecord(
        id="session-123",
        starts_at=starts_at,
        ends_at=starts_at + timedelta(seconds=30),
        status="scheduled",
        camera_feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        region_polygon=[
            SessionRegionPoint(x=0.5, y=0.3),
            SessionRegionPoint(x=0.5, y=0.7),
        ],
    )
    count_started = Event()
    release_count = Event()
    counted_sessions: list[str] = []
    resolved_sessions: list[tuple[str, int]] = []

    def count_runner(session_id, request, *, settings, stop_event):
        counted_sessions.append(session_id)
        count_started.set()
        release_count.wait(timeout=2)
        return CountSessionResult(
            session_id=session_id,
            status="resolved",
            final_count=3,
            detections_processed=6,
            started_at=request.starts_at,
            ended_at=request.ends_at,
            notes="ok",
        )

    def resolve_runner(session_id: str, final_count: int) -> int:
        resolved_sessions.append((session_id, final_count))
        return 1

    worker = AutomaticCountingWorker(
        settings=make_settings(),
        session_fetcher=lambda **_: [session],
        count_runner=count_runner,
        session_resolver=resolve_runner,
    )

    launched_first = worker._launch_due_sessions([session])
    assert launched_first == ["session-123"]
    assert count_started.wait(timeout=1)

    launched_second = worker._launch_due_sessions([session])
    assert launched_second == []

    active_thread = worker._active_jobs.get("session-123")
    assert active_thread is not None
    release_count.set()
    active_thread.join(timeout=1)

    assert counted_sessions == ["session-123"]
    assert resolved_sessions == [("session-123", 3)]


def test_worker_launches_sessions_that_have_already_started() -> None:
    session = PendingSessionRecord(
        id="session-live",
        starts_at=datetime.now(UTC) - timedelta(seconds=5),
        ends_at=datetime.now(UTC) + timedelta(seconds=25),
        status="scheduled",
        camera_feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        region_polygon=[
            SessionRegionPoint(x=0.5, y=0.3),
            SessionRegionPoint(x=0.5, y=0.7),
        ],
    )

    counted_sessions: list[str] = []
    worker = AutomaticCountingWorker(
        settings=make_settings(),
        session_fetcher=lambda **_: [session],
        count_runner=lambda session_id, request, *, settings, stop_event: (
            counted_sessions.append(session_id)
        ),
        session_resolver=lambda *_: 0,
    )

    launched = worker._launch_due_sessions([session])

    assert launched == ["session-live"]


def test_worker_skips_sessions_that_have_already_ended() -> None:
    session = PendingSessionRecord(
        id="session-ended",
        starts_at=datetime.now(UTC) - timedelta(seconds=35),
        ends_at=datetime.now(UTC) - timedelta(seconds=5),
        status="scheduled",
        camera_feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        region_polygon=[
            SessionRegionPoint(x=0.5, y=0.3),
            SessionRegionPoint(x=0.5, y=0.7),
        ],
    )

    counted_sessions: list[str] = []
    worker = AutomaticCountingWorker(
        settings=make_settings(),
        session_fetcher=lambda **_: [session],
        count_runner=lambda session_id, request, *, settings, stop_event: (
            counted_sessions.append(session_id)
        ),
        session_resolver=lambda *_: 0,
    )

    launched = worker._launch_due_sessions([session])

    assert launched == []
    assert counted_sessions == []
