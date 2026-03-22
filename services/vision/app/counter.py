from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from subprocess import PIPE, Popen, TimeoutExpired, run
from threading import Event, Lock
from time import sleep
from typing import BinaryIO
from uuid import uuid4

import numpy as np
from pydantic import BaseModel, Field, HttpUrl
from ultralytics import YOLO

from app.settings import Settings, get_settings

LOGGER = logging.getLogger("app.counter")


class Point(BaseModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)


class CountSessionRequest(BaseModel):
    feed_url: HttpUrl
    starts_at: datetime
    ends_at: datetime
    region: Sequence[Point] = Field(min_length=3)


class CountSessionResult(BaseModel):
    session_id: str
    status: str
    final_count: int = Field(ge=0)
    detections_processed: int = Field(ge=0)
    started_at: datetime
    ended_at: datetime
    notes: str


@dataclass(frozen=True)
class TrackObservation:
    id: str
    x: float
    y: float
    width: float
    height: float
    confidence: float

    @property
    def footpoint(self) -> Point:
        return Point(x=self.x + (self.width / 2), y=self.y + self.height)


@dataclass(frozen=True)
class FrameObservation:
    observed_at: datetime
    tracks: tuple[TrackObservation, ...]


@dataclass(frozen=True)
class ScanBounds:
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


@dataclass
class _TrackCrossingState:
    confirmed_inside: bool | None = None
    inside_streak: int = 0
    outside_streak: int = 0


class PolygonCrossingCounter:
    """Counts confirmed footpoint entries into the yellow ground polygon."""

    def __init__(
        self,
        *,
        polygon: Sequence[Point],
        entry_confirm_frames: int = 2,
        exit_confirm_frames: int = 2,
    ) -> None:
        self._polygon = tuple(polygon)
        self._entry_confirm_frames = max(entry_confirm_frames, 1)
        self._exit_confirm_frames = max(exit_confirm_frames, 1)
        self._states: dict[str, _TrackCrossingState] = {}

    def observe_tracks(
        self,
        tracks: Sequence[TrackObservation],
        *,
        count_enabled: bool,
    ) -> int:
        new_crossings = 0

        for track in tracks:
            state = self._states.setdefault(track.id, _TrackCrossingState())
            is_inside = is_point_inside_polygon(track.footpoint, self._polygon)

            if is_inside:
                state.inside_streak += 1
                state.outside_streak = 0

                if state.confirmed_inside is None:
                    if state.inside_streak >= self._entry_confirm_frames:
                        state.confirmed_inside = True
                    continue

                if (
                    state.confirmed_inside is False
                    and state.inside_streak >= self._entry_confirm_frames
                ):
                    state.confirmed_inside = True
                    if count_enabled:
                        new_crossings += 1
                continue

            state.outside_streak += 1
            state.inside_streak = 0

            if state.confirmed_inside is None:
                if state.outside_streak >= self._exit_confirm_frames:
                    state.confirmed_inside = False
                continue

            if state.confirmed_inside is True and state.outside_streak >= self._exit_confirm_frames:
                state.confirmed_inside = False

        return new_crossings


def is_point_inside_polygon(point: Point, polygon: Sequence[Point]) -> bool:
    is_inside = False
    previous_index = len(polygon) - 1

    for index, current_point in enumerate(polygon):
        previous_point = polygon[previous_index]
        intersects = (
            current_point.y > point.y
        ) != (previous_point.y > point.y) and point.x < (
            ((previous_point.x - current_point.x) * (point.y - current_point.y))
            / (previous_point.y - current_point.y)
            + current_point.x
        )

        if intersects:
            is_inside = not is_inside

        previous_index = index

    return is_inside


def get_region_scan_bounds(
    region: Sequence[Point],
    *,
    padding_x: float,
    padding_y: float,
) -> ScanBounds:
    min_x = min(point.x for point in region)
    max_x = max(point.x for point in region)
    min_y = min(point.y for point in region)
    max_y = max(point.y for point in region)

    return ScanBounds(
        left=max(0.0, min_x - max(padding_x, 0.0)),
        top=max(0.0, min_y - max(padding_y, 0.0)),
        right=min(1.0, max_x + max(padding_x, 0.0)),
        bottom=min(1.0, max_y + max(padding_y, 0.0)),
    )


@dataclass(frozen=True)
class StreamGeometry:
    width: int
    height: int

    @property
    def frame_size(self) -> int:
        return self.width * self.height * 3


@dataclass(frozen=True)
class RawDetection:
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float


@dataclass
class TrackState:
    id: str
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float
    hits: int
    last_seen_frame: int


@dataclass
class _CachedModel:
    model: YOLO
    lock: Lock


_MODEL_CACHE: dict[str, _CachedModel] = {}
_MODEL_CACHE_LOCK = Lock()


def _get_cached_model(model_name: str) -> _CachedModel:
    with _MODEL_CACHE_LOCK:
        cached = _MODEL_CACHE.get(model_name)
        if cached is None:
            cached = _CachedModel(model=YOLO(model_name), lock=Lock())
            _MODEL_CACHE[model_name] = cached
        return cached


class LiveSessionTrackSource:
    def __init__(
        self,
        *,
        payload: CountSessionRequest,
        settings: Settings,
        stop_event: Event | None = None,
    ) -> None:
        self._payload = payload
        self._settings = settings
        self._stop_event = stop_event or Event()
        self._model_handle = _get_cached_model(settings.detection_model_name)
        self._frame_index = 0
        self._tracks: dict[str, TrackState] = {}
        self._stream_process: Popen[bytes] | None = None
        self._scan_bounds = get_region_scan_bounds(
            payload.region,
            padding_x=settings.count_region_padding_x,
            padding_y=settings.count_region_padding_y,
        )

    def iter_observations(self) -> Iterator[FrameObservation]:
        while not self._stop_event.is_set():
            now = datetime.now(UTC)
            if now >= self._payload.starts_at:
                break

            sleep(min((self._payload.starts_at - now).total_seconds(), 0.25))

        if self._stop_event.is_set() or datetime.now(UTC) >= self._payload.ends_at:
            return

        geometry = self._probe_stream_geometry()
        if geometry is None:
            raise RuntimeError("Could not read stream geometry for counting session.")

        process = self._open_stream_process(geometry)
        if process is None:
            raise RuntimeError("Could not open ffmpeg stream for counting session.")

        try:
            while not self._stop_event.is_set():
                now = datetime.now(UTC)
                if now >= self._payload.ends_at:
                    break

                frame = self._read_frame(process, geometry)
                if frame is None:
                    error_text = self._read_process_error(process)
                    detail = f": {error_text}" if error_text else "."
                    raise RuntimeError(f"Counting stream ended unexpectedly{detail}")

                observed_at = datetime.now(UTC)
                tracks = tuple(self._detect_tracks(frame))
                yield FrameObservation(observed_at=observed_at, tracks=tracks)
        finally:
            self._close_stream_process()

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
            str(self._payload.feed_url),
        ]

        try:
            result = run(command, check=False, capture_output=True, text=True, timeout=12)
        except FileNotFoundError as exc:
            raise RuntimeError(
                "ffprobe is not installed; automatic counting requires ffmpeg."
            ) from exc
        except TimeoutExpired:
            LOGGER.warning("ffprobe timed out while probing %s", self._payload.feed_url)
            return None

        if result.returncode != 0:
            error_line = (result.stderr or "").strip().splitlines()
            error_text = error_line[0] if error_line else "unknown ffprobe error"
            LOGGER.warning("ffprobe failed for %s: %s", self._payload.feed_url, error_text)
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

        return None

    def _scale_geometry(self, *, width: int, height: int) -> StreamGeometry:
        max_width = max(self._settings.detection_stream_max_width, 0)
        if max_width <= 0 or width <= max_width:
            return StreamGeometry(width=width - (width % 2), height=height - (height % 2))

        scale = max_width / width
        scaled_width = max(2, int(width * scale))
        scaled_height = max(2, int(height * scale))
        return StreamGeometry(
            width=scaled_width - (scaled_width % 2),
            height=scaled_height - (scaled_height % 2),
        )

    def _open_stream_process(self, geometry: StreamGeometry) -> Popen[bytes] | None:
        frames_per_second = min(
            max(1000 / max(self._settings.detection_interval_ms, 1), 0.2),
            5.0,
        )
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
            str(self._payload.feed_url),
            "-an",
            "-sn",
            "-dn",
            "-vf",
            (
                f"fps={frames_per_second:.2f},"
                f"scale={geometry.width}:{geometry.height}"
            ),
            "-pix_fmt",
            "bgr24",
            "-f",
            "rawvideo",
            "pipe:1",
        ]

        try:
            process = Popen(command, stdout=PIPE, stderr=PIPE)
        except FileNotFoundError as exc:
            raise RuntimeError(
                "ffmpeg is not installed; automatic counting requires ffmpeg."
            ) from exc
        except OSError as exc:
            LOGGER.warning("ffmpeg could not start for %s: %s", self._payload.feed_url, exc)
            return None

        self._stream_process = process
        return process

    def _close_stream_process(self) -> None:
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

    def _detect_tracks(self, frame: np.ndarray) -> list[TrackObservation]:
        frame_height, frame_width = frame.shape[:2]
        self._frame_index += 1
        roi_left, roi_top, roi_right, roi_bottom = self._scan_bounds.to_frame_bounds(
            frame_width=frame_width,
            frame_height=frame_height,
        )
        roi_frame = frame[roi_top:roi_bottom, roi_left:roi_right]

        with self._model_handle.lock:
            results = self._model_handle.model.predict(
                source=roi_frame,
                conf=self._settings.detection_confidence,
                iou=self._settings.detection_nms_iou,
                imgsz=max(self._settings.detection_model_input_size, 320),
                classes=[0],
                verbose=False,
            )

        if not results:
            self._prune_tracks()
            return []

        prediction = results[0]
        boxes = prediction.boxes
        if boxes is None or len(boxes) == 0:
            self._prune_tracks()
            return []

        raw_detections: list[RawDetection] = []
        confidences = boxes.conf.cpu().tolist() if boxes.conf is not None else [0.0] * len(boxes)
        for index, (x1, y1, x2, y2) in enumerate(boxes.xyxy.cpu().tolist()):
            x1 = max(0.0, min(float(x1), float(roi_right - roi_left))) + roi_left
            y1 = max(0.0, min(float(y1), float(roi_bottom - roi_top))) + roi_top
            x2 = max(0.0, min(float(x2), float(roi_right - roi_left))) + roi_left
            y2 = max(0.0, min(float(y2), float(roi_bottom - roi_top))) + roi_top

            width = max(0.0, x2 - x1)
            height = max(0.0, y2 - y1)
            if width < 2 or height < 2:
                continue

            area_ratio = (width * height) / max(frame_width * frame_height, 1)
            if area_ratio < self._settings.detection_min_box_area_ratio:
                continue

            height_ratio = height / max(frame_height, 1)
            if height_ratio < self._settings.detection_min_box_height_ratio:
                continue

            aspect_ratio = height / max(width, 1e-6)
            if (
                aspect_ratio < self._settings.detection_min_box_aspect_ratio
                or aspect_ratio > self._settings.detection_max_box_aspect_ratio
            ):
                continue

            confidence = float(confidences[index]) if index < len(confidences) else 0.0
            raw_detections.append(
                RawDetection(
                    x1=x1,
                    y1=y1,
                    x2=x2,
                    y2=y2,
                    confidence=confidence,
                )
            )

        tracks = self._assign_tracks(
            self._non_max_suppress(raw_detections, iou_threshold=self._settings.detection_nms_iou)
        )
        visible_tracks = [
            track
            for track in tracks
            if track.hits >= max(self._settings.detection_min_track_hits, 1)
        ][: max(self._settings.detection_max_boxes, 1)]

        return [
            TrackObservation(
                id=track.id,
                x=track.x1 / frame_width,
                y=track.y1 / frame_height,
                width=(track.x2 - track.x1) / frame_width,
                height=(track.y2 - track.y1) / frame_height,
                confidence=track.confidence,
            )
            for track in visible_tracks
        ]

    def _assign_tracks(self, detections: list[RawDetection]) -> list[TrackState]:
        active_tracks = [
            track
            for track in self._tracks.values()
            if self._frame_index - track.last_seen_frame <= 8
        ]

        detection_by_index = {index: detection for index, detection in enumerate(detections)}
        unmatched_detection_indices = set(detection_by_index)
        unmatched_track_ids = {track.id for track in active_tracks}
        scored_matches: list[tuple[float, str, int]] = []
        for track in active_tracks:
            for detection_index, detection in detection_by_index.items():
                match_score = self._track_match_score(track, detection)
                if match_score is not None:
                    scored_matches.append((match_score, track.id, detection_index))

        scored_matches.sort(reverse=True)
        current_tracks: list[TrackState] = []
        for _, track_id, detection_index in scored_matches:
            if (
                track_id not in unmatched_track_ids
                or detection_index not in unmatched_detection_indices
            ):
                continue

            detection = detection_by_index[detection_index]
            track = self._tracks[track_id]
            self._update_track(track, detection)
            current_tracks.append(track)
            unmatched_track_ids.remove(track_id)
            unmatched_detection_indices.remove(detection_index)

        for detection_index in sorted(unmatched_detection_indices):
            detection = detection_by_index[detection_index]
            track = TrackState(
                id=f"track-{uuid4().hex[:8]}",
                x1=detection.x1,
                y1=detection.y1,
                x2=detection.x2,
                y2=detection.y2,
                confidence=detection.confidence,
                hits=1,
                last_seen_frame=self._frame_index,
            )
            self._tracks[track.id] = track
            current_tracks.append(track)

        current_tracks.sort(
            key=lambda track: (track.last_seen_frame, track.hits, track.confidence),
            reverse=True,
        )
        self._prune_tracks()
        return current_tracks

    def _track_match_score(self, track: TrackState, detection: RawDetection) -> float | None:
        track_box = (track.x1, track.y1, track.x2, track.y2)
        detection_box = (detection.x1, detection.y1, detection.x2, detection.y2)
        iou = self._box_iou(track_box, detection_box)
        center_distance_ratio = self._box_center_distance_ratio(track_box, detection_box)
        if iou < 0.12 and center_distance_ratio > 0.35:
            return None

        return iou + max(0.0, 0.35 - center_distance_ratio)

    def _update_track(self, track: TrackState, detection: RawDetection) -> None:
        detection_weight = 0.68 if track.hits > 1 else 1.0
        history_weight = 1.0 - detection_weight
        track.x1 = (track.x1 * history_weight) + (detection.x1 * detection_weight)
        track.y1 = (track.y1 * history_weight) + (detection.y1 * detection_weight)
        track.x2 = (track.x2 * history_weight) + (detection.x2 * detection_weight)
        track.y2 = (track.y2 * history_weight) + (detection.y2 * detection_weight)
        track.confidence = max(track.confidence * 0.6, detection.confidence)
        track.hits += 1
        track.last_seen_frame = self._frame_index

    def _prune_tracks(self) -> None:
        stale_before = self._frame_index - 10
        stale_ids = [
            track_id
            for track_id, track in self._tracks.items()
            if track.last_seen_frame < stale_before
        ]
        for track_id in stale_ids:
            self._tracks.pop(track_id, None)

    def _non_max_suppress(
        self, detections: list[RawDetection], iou_threshold: float
    ) -> list[RawDetection]:
        sorted_detections = sorted(detections, key=lambda item: item.confidence, reverse=True)
        kept: list[RawDetection] = []
        for detection in sorted_detections:
            if all(
                self._box_iou(
                    (detection.x1, detection.y1, detection.x2, detection.y2),
                    (kept_detection.x1, kept_detection.y1, kept_detection.x2, kept_detection.y2),
                )
                < iou_threshold
                for kept_detection in kept
            ):
                kept.append(detection)
        return kept

    def _box_iou(
        self, box_a: tuple[float, float, float, float], box_b: tuple[float, float, float, float]
    ) -> float:
        ax1, ay1, ax2, ay2 = box_a
        bx1, by1, bx2, by2 = box_b
        intersection_x1 = max(ax1, bx1)
        intersection_y1 = max(ay1, by1)
        intersection_x2 = min(ax2, bx2)
        intersection_y2 = min(ay2, by2)

        intersection_width = max(0.0, intersection_x2 - intersection_x1)
        intersection_height = max(0.0, intersection_y2 - intersection_y1)
        intersection_area = intersection_width * intersection_height
        if intersection_area <= 0:
            return 0.0

        area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
        area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
        union_area = area_a + area_b - intersection_area
        if union_area <= 0:
            return 0.0

        return intersection_area / union_area

    def _box_center_distance_ratio(
        self, box_a: tuple[float, float, float, float], box_b: tuple[float, float, float, float]
    ) -> float:
        ax1, ay1, ax2, ay2 = box_a
        bx1, by1, bx2, by2 = box_b
        center_a_x = (ax1 + ax2) / 2
        center_a_y = (ay1 + ay2) / 2
        center_b_x = (bx1 + bx2) / 2
        center_b_y = (by1 + by2) / 2
        center_distance = float(np.hypot(center_a_x - center_b_x, center_a_y - center_b_y))
        diagonal_a = float(np.hypot(ax2 - ax1, ay2 - ay1))
        diagonal_b = float(np.hypot(bx2 - bx1, by2 - by1))
        reference_diagonal = max(diagonal_a, diagonal_b, 1.0)
        return center_distance / reference_diagonal


def run_counting_session(
    session_id: str,
    payload: CountSessionRequest,
    *,
    frame_observations: Iterable[FrameObservation] | None = None,
    settings: Settings | None = None,
    now_provider: Callable[[], datetime] | None = None,
    stop_event: Event | None = None,
) -> CountSessionResult:
    resolved_settings = settings or get_settings()
    resolved_now_provider = now_provider or (lambda: datetime.now(UTC))
    resolved_stop_event = stop_event or Event()

    if payload.ends_at <= payload.starts_at:
        raise ValueError("Session end time must be after start time.")

    if frame_observations is None:
        current_time = resolved_now_provider()
        if payload.ends_at <= current_time:
            raise ValueError("Session must be counted before its end time.")
        if current_time > payload.starts_at:
            raise ValueError(
                "Automatic counting must begin before the session window starts."
            )

    counter = PolygonCrossingCounter(
        polygon=payload.region,
        entry_confirm_frames=max(resolved_settings.count_entry_confirm_frames, 1),
        exit_confirm_frames=max(resolved_settings.count_exit_confirm_frames, 1),
    )
    observations = frame_observations
    if observations is None:
        observations = LiveSessionTrackSource(
            payload=payload,
            settings=resolved_settings,
            stop_event=resolved_stop_event,
        ).iter_observations()

    final_count = 0
    detections_processed = 0
    last_observed_at = payload.starts_at
    count_started = False
    for observation in observations:
        last_observed_at = observation.observed_at
        if resolved_stop_event.is_set():
            break

        if observation.observed_at >= payload.ends_at:
            break

        count_enabled = observation.observed_at >= payload.starts_at
        if count_enabled:
            count_started = True
            detections_processed += len(observation.tracks)

        final_count += counter.observe_tracks(
            observation.tracks,
            count_enabled=count_enabled,
        )

    was_stopped_early = resolved_stop_event.is_set()
    status = "stopped" if was_stopped_early else "resolved"
    effective_ended_at = last_observed_at if was_stopped_early else payload.ends_at
    window_note = (
        "Counted confirmed footpoint crossings into the polygon during the session window."
        if count_started
        else "No in-window detections were processed before the session ended."
    )
    if was_stopped_early:
        notes = f"{window_note} Counting stopped before settlement."
    else:
        notes = window_note

    return CountSessionResult(
        session_id=session_id,
        status=status,
        final_count=final_count,
        detections_processed=detections_processed,
        started_at=payload.starts_at,
        ended_at=effective_ended_at,
        notes=notes,
    )
