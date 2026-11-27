# Production image for services/ai. Internal only: no port is published in compose (SEC-14).
FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv PATH="/opt/venv/bin:$PATH"
WORKDIR /app

# Tesseract (English) for OCR of scanned uploads (#253); it runs locally, never remotely (ADR-0008).
RUN apt-get update \n    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \n    && rm -rf /var/lib/apt/lists/*

# Dependencies first (cached layer), then the project itself.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --extra ocr --no-install-project
COPY src ./src
COPY README.md alembic.ini ./
COPY migrations ./migrations
RUN uv sync --frozen --no-dev --extra ocr

RUN useradd --system --uid 10001 caseguard
USER caseguard
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
# Apply the corpus/ai migrations first, as the api image does for app (#15).
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn caseguard_ai.main:app --host 0.0.0.0 --port 8000"]
