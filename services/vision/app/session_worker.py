from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Event, Lock, Thread
from time import sleep

from app.counter import CountSessionRequest, CountSessionResult, Point, run_counting_session
from app.settings import Settings
from app.supabase import (
    PendingSessionRecord,
    list_countable_sessions,
    resolve_session_in_supabase_sync,
)


@dataclass(frozen=True)
class _SessionJobInput:
    session_id: str
    request: CountSessionRequest


class AutomaticCountingWorker:
    def __init__(
        self,
        *,
        settings: Settings,
        session_fetcher: Callable[..., Sequence[PendingSessionRecord]] = list_countable_sessions,
        count_runner: Callable[..., CountSessionResult] = run_counting_session,
        session_resolver: Callable[[str, int], int] = resolve_session_in_supabase_sync,
    ) -> None:
        self._settings = settings
        self._session_fetcher = session_fetcher
        self._count_runner = count_runner
        self._session_resolver = session_resolver
        self._logger = logging.getLogger("app.session_worker")
        self._stop_event = Event()
        self._thread: Thread | None = None
        self._active_jobs: dict[str, Thread] = {}
        self._active_jobs_lock = Lock()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()

        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.5)

        with self._active_jobs_lock:
            active_threads = list(self._active_jobs.values())

        for thread in active_threads:
            if thread.is_alive():
                thread.join(timeout=2.5)

    def _run_loop(self) -> None:
        poll_delay = max(self._settings.auto_count_poll_interval_ms / 1000, 0.25)

        while not self._stop_event.is_set():
            try:
                now = datetime.now(UTC)
                due_sessions = self._session_fetcher(
                    now=now,
                    lookahead_ms=self._settings.auto_count_session_lookahead_ms,
                )
                self._launch_due_sessions(due_sessions)
            except Exception as exc:  # noqa: BLE001
                self._logger.exception("automatic counting worker loop failed: %s", exc)

            sleep(poll_delay)

    def _launch_due_sessions(
        self, sessions: Sequence[PendingSessionRecord]
    ) -> list[str]:
        launched_session_ids: list[str] = []
        current_time = datetime.now(UTC)

        for session in sessions:
            if session.resolved_at is not None or session.final_count is not None:
                continue
            if session.status in {"resolved", "cancelled"}:
                continue
            if session.ends_at <= current_time:
                continue

            with self._active_jobs_lock:
                if session.id in self._active_jobs:
                    continue

                job_input = _SessionJobInput(
                    session_id=session.id,
                    request=CountSessionRequest(
                        feed_url=session.camera_feed_url,
                        starts_at=session.starts_at,
                        ends_at=session.ends_at,
                        region=[
                            Point(x=point.x, y=point.y) for point in session.region_polygon
                        ],
                    ),
                )
                thread = Thread(
                    target=self._run_session_job,
                    args=(job_input,),
                    daemon=True,
                )
                self._active_jobs[session.id] = thread

            thread.start()
            launched_session_ids.append(session.id)

        return launched_session_ids

    def _run_session_job(self, job_input: _SessionJobInput) -> None:
        try:
            result = self._count_runner(
                job_input.session_id,
                job_input.request,
                settings=self._settings,
                stop_event=self._stop_event,
            )
            if result.status != "resolved" or self._stop_event.is_set():
                self._logger.info(
                    "skipping settlement for %s because counting stopped early",
                    job_input.session_id,
                )
                return

            processed_predictions = self._session_resolver(
                job_input.session_id,
                result.final_count,
            )
            self._logger.info(
                "settled session %s automatically with final_count=%s processed_predictions=%s",
                job_input.session_id,
                result.final_count,
                processed_predictions,
            )
        except Exception as exc:  # noqa: BLE001
            self._logger.exception(
                "automatic counting job failed for %s: %s",
                job_input.session_id,
                exc,
            )
        finally:
            with self._active_jobs_lock:
                self._active_jobs.pop(job_input.session_id, None)
