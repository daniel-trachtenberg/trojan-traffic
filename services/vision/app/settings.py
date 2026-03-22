from functools import lru_cache

from pydantic import HttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "trojan-traffic-vision"
    log_level: str = "INFO"
    camera_playlist_url: HttpUrl = HttpUrl(
        "https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8"
    )
    enable_live_detections: bool = True
    detection_model_name: str = "yolo11s.pt"
    detection_confidence: float = 0.3
    detection_interval_ms: int = 600
    detection_stream_max_width: int = 1280
    detection_model_input_size: int = 1280
    detection_nms_iou: float = 0.45
    detection_region_left: float = 0.0
    detection_region_top: float = 0.0
    detection_region_right: float = 1.0
    detection_region_bottom: float = 1.0
    detection_min_box_area_ratio: float = 0.00012
    detection_min_box_height_ratio: float = 0.022
    detection_min_box_aspect_ratio: float = 1.2
    detection_max_box_aspect_ratio: float = 6.0
    detection_min_track_hits: int = 1
    detection_max_boxes: int = 24
    detection_reconnect_delay_ms: int = 1200
    enable_auto_count_worker: bool = True
    auto_count_poll_interval_ms: int = 1000
    auto_count_session_lookahead_ms: int = 20000
    count_entry_confirm_frames: int = 2
    count_exit_confirm_frames: int = 2
    cors_origins: str = "*"
    supabase_url: HttpUrl | None = None
    supabase_service_role_key: str | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
