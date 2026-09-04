# ============================================================
# DocFlow Backend — Multi-Stage Dockerfile
# ============================================================

# ------- Stage 1: Base dependencies -------
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PIP_NO_CACHE_DIR=off \
    PIP_DISABLE_PIP_VERSION_CHECK=on

# System deps for asyncpg, Pillow, Tesseract, python-jose
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    libjpeg-dev \
    zlib1g-dev \
    libffi-dev \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    libmagic1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ------- Stage 2: Python dependencies -------
FROM base AS deps

COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# ------- Stage 3: Development (hot reload) -------
FROM deps AS development

COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload", "--log-level", "debug"]

# ------- Stage 4: Production -------
FROM deps AS production

# Create non-root user for security
RUN addgroup --system --gid 1001 docflow && \
    adduser --system --uid 1001 --gid 1001 --no-create-home docflow

COPY --chown=docflow:docflow . .

USER docflow

EXPOSE 8000

# Entrypoint runs migrations then starts gunicorn
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["gunicorn", "app.main:app", \
     "--worker-class", "uvicorn.workers.UvicornWorker", \
     "--workers", "4", \
     "--bind", "0.0.0.0:8000", \
     "--timeout", "60", \
     "--keep-alive", "5", \
     "--access-logfile", "-", \
     "--error-logfile", "-"]
