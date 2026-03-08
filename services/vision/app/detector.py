from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from subprocess import PIPE, Popen, TimeoutExpired, run
from threading import Event, Lock, Thread
from time import perf_counter, sleep
from typing import Any, BinaryIO
from uuid import uuid4

import numpy as np
from ultralytics import YOLO


@dataclass(frozen=True)
class DetectorSnapshot:
    status: str
    source_url: str
    updated_at: str | None
    processing_ms: float | None
    boxes: list[dict[str, Any]]


@dataclass(frozen=True)
class StreamGeometry:
    width: int
    height: int

    @property
    def frame_size(self) -> int:
        return self.width * self.height * 3


@dataclass(frozen=True)
class DetectionRegion:
    left: float
    top: float
    right: float
    bottom: float

    def to_frame_bounds(self, *, frame_width: int, frame_height: int) -> tuple[int, int, int, int]:
        left = max(0, min(int(frame_width * self.left), frame_width - 2))
        top = max(0, min(int(frame_height * self.top), frame_height - 2))
        right = max(left + 2, min(int(frame_width * self.right), frame_width))
        bottom = max(top + 2, min(int(frame_height * self.bottom), frame_height))
        return left, top, right, bottom


class LivePersonDetector:
    def __init__(
        self,
        source_url: str,
        model_name: str,
        confidence: float,
        interval_ms: int,
        stream_max_width: int,
        region_left: float,
        region_top: float,
        region_right: float,
        region_bottom: float,
        min_box_area_ratio: float,
        min_box_height_ratio: float,
        min_box_aspect_ratio: float,
        max_box_aspect_ratio: float,
        min_track_hits: int,
        reconnect_delay_ms: int,
        max_boxes: int,
    ) -> None:
        self._source_url = source_url
        self._model = YOLO(model_name)
        self._confidence = confidence
        self._target_fps = min(max(1000 / max(interval_ms, 1), 1.0), 5.0)
        self._stream_max_width = max(stream_max_width, 0)
        self._detection_region = DetectionRegion(
            left=max(0.0, min(region_left, 0.98)),
            top=max(0.0, min(region_top, 0.98)),
            right=max(region_left + 0.01, min(region_right, 1.0)),
            bottom=max(region_top + 0.01, min(region_bottom, 1.0)),
        )
        self._min_box_area_ratio = max(min_box_area_ratio, 0.0)
        self._min_box_height_ratio = max(min_box_height_ratio, 0.0)
        self._min_box_aspect_ratio = max(min_box_aspect_ratio, 0.0)
        self._max_box_aspect_ratio = max(max_box_aspect_ratio, self._min_box_aspect_ratio)
        self._min_track_hits = max(min_track_hits, 1)
        self._reconnect_delay_seconds = max(reconnect_delay_ms / 1000, 0.3)
        self._max_boxes = max(max_boxes, 1)
        self._logger = logging.getLogger("app.detector")
        self._track_hits: dict[str, int] = {}
        self._track_last_seen: dict[str, int] = {}
        self._frame_index = 0

        self._state_lock = Lock()
        self._process_lock = Lock()
        self._snapshot = DetectorSnapshot(
            status="warming",
            source_url=source_url,
            updated_at=None,
            processing_ms=None,
            boxes=[],
        )
        self._stop_event = Event()
        self._thread: Thread | None = None
        self._stream_process: Popen[bytes] | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._close_stream_process()
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
            geometry = self._probe_stream_geometry()
            if geometry is None:
                self._set_snapshot(status="offline")
                sleep(self._reconnect_delay_seconds)
                continue

            process = self._open_stream_process(geometry)
            if process is None:
                self._set_snapshot(status="offline")
                sleep(self._reconnect_delay_seconds)
                continue

            self._set_snapshot(status="connecting")

            try:
                while not self._stop_event.is_set():
                    frame = self._read_frame(process, geometry)
                    if frame is None:
                        error_text = self._read_process_error(process)
                        if error_text:
                            self._logger.warning("ffmpeg stream ended: %s", error_text)
                        break

                    started_at = perf_counter()
                    boxes = self._track_people(frame)
                    processing_ms = round((perf_counter() - started_at) * 1000, 2)
                    self._set_snapshot(
                        status="online",
                        boxes=boxes,
                        processing_ms=processing_ms,
                    )
            finally:
                self._close_stream_process()

            if not self._stop_event.is_set():
                self._set_snapshot(status="offline")
                sleep(self._reconnect_delay_seconds)

    def _probe_stream_geometry(self) -> StreamGeometry | None:
        command = [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
            self._source_url,
        ]

        try:
            result = run(command, check=False, capture_output=True, text=True, timeout=12)
        except FileNotFoundError:
            self._logger.warning("ffprobe is not installed; live tracking requires ffmpeg tools.")
            return None
        except TimeoutExpired:
            self._logger.warning("ffprobe timed out while probing %s", self._source_url)
            return None

        if result.returncode != 0:
            error_line = (result.stderr or "").strip().splitlines()
            error_text = error_line[0] if error_line else "unknown ffprobe error"
            self._logger.warning("ffprobe failed for %s: %s", self._source_url, error_text)
            return None

        for raw_line in result.stdout.splitlines():
            line = raw_line.strip()
            if "x" not in line:
                continue

            width_text, height_text = line.split("x", maxsplit=1)
            try:
                width = int(width_text)
                height = int(height_text)
            except ValueError:
                continue

            if width > 0 and height > 0:
                return self._scale_geometry(width=width, height=height)

        self._logger.warning("ffprobe did not return usable dimensions for %s", self._source_url)
        return None

    def _scale_geometry(self, *, width: int, height: int) -> StreamGeometry:
        max_width = self._stream_max_width
        if max_width <= 0:
            return StreamGeometry(width=width - (width % 2), height=height - (height % 2))

        if width <= max_width:
            return StreamGeometry(width=width - (width % 2), height=height - (height % 2))

        scale = max_width / width
        scaled_width = max(2, int(width * scale))
        scaled_height = max(2, int(height * scale))
        return StreamGeometry(
            width=scaled_width - (scaled_width % 2),
            height=scaled_height - (scaled_height % 2),
        )

    def _open_stream_process(self, geometry: StreamGeometry) -> Popen[bytes] | None:
        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "2",
            "-i",
            self._source_url,
            "-an",
            "-sn",
            "-dn",
            "-vf",
            f"fps={self._target_fps:.2f},scale={geometry.width}:{geometry.height}",
            "-pix_fmt",
            "bgr24",
            "-f",
            "rawvideo",
            "pipe:1",
        ]

        try:
            process = Popen(command, stdout=PIPE, stderr=PIPE)
        except FileNotFoundError:
            self._logger.warning("ffmpeg is not installed; live tracking requires ffmpeg.")
            return None
        except OSError as exc:
            self._logger.warning("ffmpeg could not start for %s: %s", self._source_url, exc)
            return None

        with self._process_lock:
            self._stream_process = process

        return process

    def _close_stream_process(self) -> None:
        with self._process_lock:
            process = self._stream_process
            self._stream_process = None

        if process is None:
            return

        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1.5)
            except TimeoutExpired:
                process.kill()
                process.wait(timeout=1.0)

        if process.stdout:
            process.stdout.close()
        if process.stderr:
            process.stderr.close()

    def _read_process_error(self, process: Popen[bytes]) -> str | None:
        if process.stderr is None:
            return None

        try:
            error_output = process.stderr.read()
        except OSError:
            return None

        if not error_output:
            return None

        lines = error_output.decode("utf-8", errors="ignore").splitlines()
        return lines[0].strip() if lines else None

    def _read_frame(self, process: Popen[bytes], geometry: StreamGeometry) -> np.ndarray | None:
        if process.stdout is None:
            return None

        frame_bytes = self._read_exact(process.stdout, geometry.frame_size)
        if frame_bytes is None:
            return None

        frame = np.frombuffer(frame_bytes, dtype=np.uint8)
        if frame.size != geometry.frame_size:
            return None

        return frame.reshape((geometry.height, geometry.width, 3)).copy()

    def _read_exact(self, stream: BinaryIO, expected_size: int) -> bytes | None:
        buffer = bytearray()
        while len(buffer) < expected_size and not self._stop_event.is_set():
            chunk = stream.read(expected_size - len(buffer))
            if not chunk:
                return None
            buffer.extend(chunk)

        if len(buffer) != expected_size:
            return None

        return bytes(buffer)

    def _track_people(self, frame: np.ndarray) -> list[dict[str, Any]]:
        frame_height, frame_width = frame.shape[:2]
        self._frame_index += 1
        roi_left, roi_top, roi_right, roi_bottom = self._detection_region.to_frame_bounds(
            frame_width=frame_width,
            frame_height=frame_height,
        )
        roi_frame = frame[roi_top:roi_bottom, roi_left:roi_right]

        results = self._model.track(
            source=roi_frame,
            conf=self._confidence,
            classes=[0],
            persist=True,
            verbose=False,
        )
        if not results:
            return []

        prediction = results[0]
        boxes = prediction.boxes
        if boxes is None or len(boxes) == 0:
            self._prune_tracks()
            return []

        roi_height, roi_width = prediction.orig_shape
        if roi_height <= 0 or roi_width <= 0:
            self._prune_tracks()
            return []

        xyxy_values = boxes.xyxy.cpu().tolist()
        confidences = boxes.conf.cpu().tolist() if boxes.conf is not None else [0.0] * len(xyxy_values)
        track_ids = boxes.id.int().cpu().tolist() if boxes.id is not None else [None] * len(xyxy_values)

        detections: list[dict[str, Any]] = []
        for index, (x1, y1, x2, y2) in enumerate(xyxy_values[: self._max_boxes]):
            x1 = max(0.0, min(float(x1), float(roi_width))) + roi_left
            y1 = max(0.0, min(float(y1), float(roi_height))) + roi_top
            x2 = max(0.0, min(float(x2), float(roi_width))) + roi_left
            y2 = max(0.0, min(float(y2), float(roi_height))) + roi_top

            width = max(0.0, x2 - x1)
            height = max(0.0, y2 - y1)
            if width < 2 or height < 2:
                continue

            area_ratio = (width * height) / max(frame_width * frame_height, 1)
            if area_ratio < self._min_box_area_ratio:
                continue

            height_ratio = height / max(frame_height, 1)
            if height_ratio < self._min_box_height_ratio:
                continue

            aspect_ratio = height / max(width, 1e-6)
            if aspect_ratio < self._min_box_aspect_ratio or aspect_ratio > self._max_box_aspect_ratio:
                continue

            track_id = track_ids[index]
            confidence = float(confidences[index]) if index < len(confidences) else 0.0
            track_key = f"track-{track_id}" if track_id is not None else str(uuid4())
            if track_id is not None:
                self._track_hits[track_key] = self._track_hits.get(track_key, 0) + 1
                self._track_last_seen[track_key] = self._frame_index
                if self._track_hits[track_key] < self._min_track_hits:
                    continue

            detections.append(
                {
                    "id": track_key,
                    "x": round(x1 / frame_width, 4),
                    "y": round(y1 / frame_height, 4),
                    "width": round(width / frame_width, 4),
                    "height": round(height / frame_height, 4),
                    "confidence": round(confidence, 3),
                }
            )

        self._prune_tracks()
        return detections

    def _prune_tracks(self) -> None:
        stale_before = self._frame_index - 12
        stale_ids = [
            track_id for track_id, last_seen in self._track_last_seen.items() if last_seen < stale_before
        ]
        for track_id in stale_ids:
            self._track_last_seen.pop(track_id, None)
            self._track_hits.pop(track_id, None)
