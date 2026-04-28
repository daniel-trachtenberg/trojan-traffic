from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from inspect import Parameter, signature
from threading import Event, Lock, Thread
from time import sleep

from app.counter import CountSessionRequest, CountSessionResult, Point, run_counting_session
from app.settings import Settings
from app.supabase import (
    AutoResolutionSessionRecord,
    PendingSessionRecord,
    list_auto_resolution_sessions,
    list_countable_sessions,
    resolve_session_in_supabase_sync,
    update_session_live_count_sync,
)


@dataclass(frozen=True)
class _SessionJobInput:
    session_id: str
    request: CountSessionRequest
    initial_count: int


class AutomaticCountingWorker:
    def __init__(
        self,
        *,
        settings: Settings,
        session_fetcher: Callable[..., Sequence[PendingSessionRecord]] = list_countable_sessions,
        auto_resolution_fetcher: Callable[
            ..., Sequence[AutoResolutionSessionRecord]
        ] = list_auto_resolution_sessions,
        count_runner: Callable[..., CountSessionResult] = run_counting_session,
        session_resolver: Callable[[str, int], int] = resolve_session_in_supabase_sync,
        session_live_count_updater: Callable[[str, int], None] = update_session_live_count_sync,
    ) -> None:
        self._settings = settings
        self._session_fetcher = session_fetcher
        self._auto_resolution_fetcher = auto_resolution_fetcher
        self._count_runner = count_runner
        self._session_resolver = session_resolver
        self._session_live_count_updater = session_live_count_updater
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
        self._logger.info(
            "automatic counting worker loop started poll_interval_ms=%s lookahead_ms=%s",
            self._settings.auto_count_poll_interval_ms,
            self._settings.auto_count_session_lookahead_ms,
        )

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
                if due_sessions:
                    self._logger.info("found %s countable session(s)", len(due_sessions))
                self._launch_due_sessions(due_sessions)
                self._resolve_finished_counting_sessions(now=now)
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
                self._logger.info(
                    "skipping ended session %s starts_at=%s ends_at=%s",
                    session.id,
                    session.starts_at.isoformat(),
                    session.ends_at.isoformat(),
                )
                continue

            with self._active_jobs_lock:
                if session.id in self._active_jobs:
                    continue

                job_input = _SessionJobInput(
                    session_id=session.id,
                    initial_count=session.live_count,
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
            self._logger.info(
                "launched counting job session=%s starts_at=%s ends_at=%s live_count=%s",
                session.id,
                session.starts_at.isoformat(),
                session.ends_at.isoformat(),
                session.live_count,
            )

        return launched_session_ids

    def _resolve_finished_counting_sessions(self, *, now: datetime) -> list[str]:
        sessions = self._auto_resolution_fetcher(now=now)
        resolved_session_ids: list[str] = []

        with self._active_jobs_lock:
            active_session_ids = set(self._active_jobs)

        for session in sessions:
            if session.id in active_session_ids:
                continue
            if session.live_count <= 0:
                self._logger.warning(
                    "not auto-finalizing ended session %s because no positive live count was "
                    "published before the worker stopped",
                    session.id,
                )
                continue

            try:
                processed_predictions = self._session_resolver(
                    session.id,
                    session.live_count,
                )
            except Exception as exc:  # noqa: BLE001
                self._logger.exception(
                    "automatic finalization failed for %s: %s",
                    session.id,
                    exc,
                )
                continue

            resolved_session_ids.append(session.id)
            self._logger.info(
                "auto-finalized session %s with live_count=%s processed_predictions=%s",
                session.id,
                session.live_count,
                processed_predictions,
            )

        return resolved_session_ids

    def _run_session_job(self, job_input: _SessionJobInput) -> None:
        try:
            result = self._run_count_runner(
                job_input,
                count_update_handler=lambda live_count: self._publish_live_count(
                    job_input.session_id,
                    live_count,
                ),
            )
            if result.status != "resolved" or self._stop_event.is_set():
                self._logger.info(
                    "skipping settlement for %s because counting stopped early",
                    job_input.session_id,
                )
                return

            self._publish_live_count(job_input.session_id, result.final_count)
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

    def _run_count_runner(
        self,
        job_input: _SessionJobInput,
        *,
        count_update_handler: Callable[[int], None],
    ) -> CountSessionResult:
        kwargs = {
            "settings": self._settings,
            "stop_event": self._stop_event,
        }
        if self._count_runner_supports_live_updates():
            kwargs["count_update_handler"] = count_update_handler
        if self._count_runner_supports_initial_count():
            kwargs["initial_count"] = job_input.initial_count

        return self._count_runner(
            job_input.session_id,
            job_input.request,
            **kwargs,
        )

    def _count_runner_supports_live_updates(self) -> bool:
        try:
            parameters = signature(self._count_runner).parameters
        except (TypeError, ValueError):
            return True

        return "count_update_handler" in parameters or any(
            parameter.kind == Parameter.VAR_KEYWORD for parameter in parameters.values()
        )

    def _count_runner_supports_initial_count(self) -> bool:
        try:
            parameters = signature(self._count_runner).parameters
        except (TypeError, ValueError):
            return True

        return "initial_count" in parameters or any(
            parameter.kind == Parameter.VAR_KEYWORD for parameter in parameters.values()
        )

    def _publish_live_count(self, session_id: str, live_count: int) -> None:
        if not self._settings.supabase_url or not self._settings.supabase_service_role_key:
            return

        try:
            self._session_live_count_updater(session_id, live_count)
        except Exception as exc:  # noqa: BLE001
            self._logger.warning(
                "could not publish live count for session %s: %s",
                session_id,
                exc,
            )
