from datetime import UTC, datetime, timedelta
from threading import Event

from app.counter import CountSessionResult
from app.session_worker import AutomaticCountingWorker
from app.settings import Settings
from app.supabase import AutoResolutionSessionRecord, PendingSessionRecord, SessionRegionPoint


def make_settings() -> Settings:
    return Settings(
        enable_live_detections=False,
        enable_auto_count_worker=True,
        auto_count_poll_interval_ms=50,
        auto_count_session_lookahead_ms=5000,
        supabase_url=None,
        supabase_service_role_key=None,
    )


def make_configured_settings() -> Settings:
    return Settings(
        enable_live_detections=False,
        enable_auto_count_worker=True,
        auto_count_poll_interval_ms=50,
        auto_count_session_lookahead_ms=5000,
        supabase_url="https://example.supabase.co",
        supabase_service_role_key="service-role-key",
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

    def count_runner(session_id, request, *, settings, stop_event):
        counted_sessions.append(session_id)
        return CountSessionResult(
            session_id=session_id,
            status="resolved",
            final_count=0,
            detections_processed=0,
            started_at=request.starts_at,
            ended_at=request.ends_at,
            notes="ok",
        )

    worker = AutomaticCountingWorker(
        settings=make_settings(),
        session_fetcher=lambda **_: [session],
        count_runner=count_runner,
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


def test_worker_auto_finalizes_ended_counting_sessions() -> None:
    resolved_sessions: list[tuple[str, int]] = []
    worker = AutomaticCountingWorker(
        settings=make_settings(),
        session_fetcher=lambda **_: [],
        auto_resolution_fetcher=lambda **_: [
            AutoResolutionSessionRecord(id="session-counted", live_count=7)
        ],
        count_runner=lambda *_args, **_kwargs: None,
        session_resolver=lambda session_id, final_count: resolved_sessions.append(
            (session_id, final_count)
        )
        or 2,
    )

    resolved = worker._resolve_finished_counting_sessions(now=datetime.now(UTC))

    assert resolved == ["session-counted"]
    assert resolved_sessions == [("session-counted", 7)]


def test_worker_does_not_auto_finalize_active_counting_job() -> None:
    resolved_sessions: list[tuple[str, int]] = []
    worker = AutomaticCountingWorker(
        settings=make_settings(),
        session_fetcher=lambda **_: [],
        auto_resolution_fetcher=lambda **_: [
            AutoResolutionSessionRecord(id="session-active", live_count=4)
        ],
        count_runner=lambda *_args, **_kwargs: None,
        session_resolver=lambda session_id, final_count: resolved_sessions.append(
            (session_id, final_count)
        )
        or 1,
    )
    worker._active_jobs["session-active"] = object()

    resolved = worker._resolve_finished_counting_sessions(now=datetime.now(UTC))

    assert resolved == []
    assert resolved_sessions == []


def test_worker_does_not_auto_finalize_zero_count_after_crash() -> None:
    resolved_sessions: list[tuple[str, int]] = []
    worker = AutomaticCountingWorker(
        settings=make_settings(),
        session_fetcher=lambda **_: [],
        auto_resolution_fetcher=lambda **_: [
            AutoResolutionSessionRecord(id="session-zero", live_count=0)
        ],
        count_runner=lambda *_args, **_kwargs: None,
        session_resolver=lambda session_id, final_count: resolved_sessions.append(
            (session_id, final_count)
        )
        or 1,
    )

    resolved = worker._resolve_finished_counting_sessions(now=datetime.now(UTC))

    assert resolved == []
    assert resolved_sessions == []


def test_worker_publishes_live_count_updates_from_runner() -> None:
    starts_at = datetime.now(UTC) - timedelta(seconds=1)
    session = PendingSessionRecord(
        id="session-live-count",
        starts_at=starts_at,
        ends_at=starts_at + timedelta(seconds=30),
        status="scheduled",
        camera_feed_url="https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8",
        region_polygon=[
            SessionRegionPoint(x=0.5, y=0.3),
            SessionRegionPoint(x=0.5, y=0.7),
        ],
    )
    live_updates: list[tuple[str, int]] = []
    count_started = Event()
    release_count = Event()

    def count_runner(
        session_id,
        request,
        *,
        settings,
        stop_event,
        initial_count,
        count_update_handler,
    ):
        count_update_handler(initial_count)
        count_update_handler(5)
        count_started.set()
        release_count.wait(timeout=2)
        return CountSessionResult(
            session_id=session_id,
            status="resolved",
            final_count=5,
            detections_processed=2,
            started_at=request.starts_at,
            ended_at=request.ends_at,
            notes="ok",
        )

    worker = AutomaticCountingWorker(
        settings=make_configured_settings(),
        session_fetcher=lambda **_: [session],
        count_runner=count_runner,
        session_resolver=lambda *_: 0,
        session_live_count_updater=lambda session_id, count: live_updates.append(
            (session_id, count)
        ),
    )

    launched = worker._launch_due_sessions([session])
    assert launched == ["session-live-count"]
    assert count_started.wait(timeout=1)

    active_thread = worker._active_jobs.get("session-live-count")
    assert active_thread is not None
    release_count.set()
    active_thread.join(timeout=1)

    assert live_updates == [
        ("session-live-count", 0),
        ("session-live-count", 5),
        ("session-live-count", 5),
    ]
