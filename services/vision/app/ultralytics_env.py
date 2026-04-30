from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def configure_ultralytics_environment() -> None:
    configured_dir = os.environ.get("YOLO_CONFIG_DIR")
    config_dir = (
        Path(configured_dir)
        if configured_dir
        else Path(__file__).resolve().parents[1] / ".ultralytics-config"
    )
    config_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("YOLO_CONFIG_DIR", str(config_dir))


def load_yolo_class() -> type[Any]:
    configure_ultralytics_environment()
    from ultralytics import YOLO

    return YOLO
