from functools import lru_cache

from pydantic import HttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "trojan-traffic-vision"
    log_level: str = "INFO"
    camera_playlist_url: HttpUrl = HttpUrl(
        "https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8"
    )
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
