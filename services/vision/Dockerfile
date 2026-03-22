FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=10000

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY app ./app
COPY yolo11s.pt ./yolo11s.pt

RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install .

EXPOSE 10000

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-10000}"]
