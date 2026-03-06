from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from subprocess import TimeoutExpired, run
from threading import Event, Lock, Thread
from time import perf_counter, sleep
from tempfile import NamedTemporaryFile
from typing import Any
from urllib.parse import urljoin
from uuid import uuid4

import httpx
from ultralytics import YOLO


@dataclass(frozen=True)
class DetectorSnapshot:
    status: str
    source_url: str
    updated_at: str | None
    processing_ms: float | None
    boxes: list[dict[str, Any]]


class LivePersonDetector:
    def __init__(
        self,
        source_url: str,
        model_name: str,
        confidence: float,
        interval_ms: int,
        reconnect_delay_ms: int,
        max_boxes: int,
    ) -> None:
        self._source_url = source_url
        self._model = YOLO(model_name)
        self._confidence = confidence
        self._interval_seconds = max(interval_ms / 1000, 0.2)
        self._reconnect_delay_seconds = max(reconnect_delay_ms / 1000, 0.3)
        self._max_boxes = max(max_boxes, 1)
        self._logger = logging.getLogger("app.detector")

        self._state_lock = Lock()
        self._snapshot = DetectorSnapshot(
            status="warming",
            source_url=source_url,
            updated_at=None,
            processing_ms=None,
            boxes=[],
        )
        self._stop_event = Event()
        self._thread: Thread | None = None

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

    def get_snapshot(self) -> DetectorSnapshot:
        with self._state_lock:
            return DetectorSnapshot(
                status=self._snapshot.status,
                source_url=self._snapshot.source_url,
                updated_at=self._snapshot.updated_at,
                processing_ms=self._snapshot.processing_ms,
                boxes=[dict(box) for box in self._snapshot.boxes],
            )

    def _set_snapshot(
        self,
        *,
        status: str,
        boxes: list[dict[str, Any]] | None = None,
        processing_ms: float | None = None,
        source_url: str | None = None,
    ) -> None:
        with self._state_lock:
            self._snapshot = DetectorSnapshot(
                status=status,
                source_url=source_url or self._source_url,
                updated_at=datetime.now(timezone.utc).isoformat(),
                processing_ms=processing_ms,
                boxes=boxes or [],
            )

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            stream_url = self._resolve_stream_url()
            frame_path = self._capture_frame(stream_url)
            if frame_path is None:
                self._set_snapshot(status="offline", source_url=stream_url)
                sleep(self._reconnect_delay_seconds)
                continue

            try:
                started_at = perf_counter()
                boxes = self._detect_people(frame_path)
                processing_ms = round((perf_counter() - started_at) * 1000, 2)
                self._set_snapshot(
                    status="online",
                    boxes=boxes,
                    processing_ms=processing_ms,
                    source_url=stream_url,
                )
            finally:
                Path(frame_path).unlink(missing_ok=True)

            sleep(self._interval_seconds)

    def _resolve_stream_url(self) -> str:
        try:
            response = httpx.get(self._source_url, timeout=8.0)
            response.raise_for_status()
        except Exception:
            return self._source_url

        lines = [line.strip() for line in response.text.splitlines() if line.strip()]
        media_paths = [line for line in lines if not line.startswith("#")]
        if not media_paths:
            return self._source_url

        return urljoin(self._source_url, media_paths[-1])

    def _capture_frame(self, stream_url: str) -> str | None:
        with NamedTemporaryFile(suffix=".jpg", delete=False) as temp_file:
            output_path = temp_file.name

        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-fflags",
            "nobuffer",
            "-i",
            stream_url,
            "-frames:v",
            "1",
            "-q:v",
            "2",
            output_path,
        ]

        try:
            process = run(command, check=False, capture_output=True, text=True, timeout=12)
        except TimeoutExpired:
            self._logger.warning("ffmpeg timed out while reading %s", stream_url)
            Path(output_path).unlink(missing_ok=True)
            return None

        if process.returncode != 0:
            error_line = (process.stderr or "").strip().splitlines()
            error_text = error_line[0] if error_line else "unknown ffmpeg error"
            self._logger.warning("ffmpeg failed for %s: %s", stream_url, error_text)
            Path(output_path).unlink(missing_ok=True)
            return None

        image_path = Path(output_path)
        if not image_path.exists() or image_path.stat().st_size == 0:
            image_path.unlink(missing_ok=True)
            return None

        return output_path

    def _detect_people(self, image_path: str) -> list[dict[str, Any]]:
        results = self._model.predict(
            source=image_path,
            conf=self._confidence,
            classes=[0],
            verbose=False,
        )
        if not results:
            return []

        detections: list[dict[str, Any]] = []
        prediction = results[0]
        frame_height, frame_width = prediction.orig_shape
        if frame_height <= 0 or frame_width <= 0:
            return detections

        if prediction.boxes is None:
            return detections

        for raw_box in prediction.boxes[: self._max_boxes]:
            x1, y1, x2, y2 = raw_box.xyxy[0].tolist()
            x1 = max(0.0, min(float(x1), float(frame_width)))
            y1 = max(0.0, min(float(y1), float(frame_height)))
            x2 = max(0.0, min(float(x2), float(frame_width)))
            y2 = max(0.0, min(float(y2), float(frame_height)))

            width = max(0.0, x2 - x1)
            height = max(0.0, y2 - y1)
            if width < 2 or height < 2:
                continue

            confidence = float(raw_box.conf[0].item()) if raw_box.conf is not None else 0.0
            detections.append(
                {
                    "id": str(uuid4()),
                    "x": round(x1 / frame_width, 4),
                    "y": round(y1 / frame_height, 4),
                    "width": round(width / frame_width, 4),
                    "height": round(height / frame_height, 4),
                    "confidence": round(confidence, 3),
                }
            )

        return detections
