# Scrimmagine: the FastAPI backend and the static frontend in one image.
#
# The play-by-play data, WP model and today's 6 scenarios are built INTO the image, so the
# running container never needs nflverse (only the internet for optional Claude commentary).
#
#   docker build -t scrimmagine --build-arg DATA_DATE=2026-11-07 .
#   docker run --rm -p 8000:8000 scrimmagine
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app/backend

# 1. Dependencies first, so editing code doesn't reinstall them.
COPY backend/requirements.txt .
RUN pip install -r requirements.txt

# 2. Backend code, then build the data: download play-by-play (~1 min), train the WP model
#    (~30 s), pick the day's scenarios. Docker caches this step; pass a new DATA_DATE to
#    redo it (e.g. daily, for a fresh set of 6). Intros use templates here: the API key is
#    deliberately not available at build time.
COPY backend/ .
ARG DATA_DATE=unset
RUN echo "Building data for ${DATA_DATE}" \
 && python -m scripts.download_data \
 && python -m scripts.train_wp \
 && python -m scripts.build_scenarios

# 3. Everything the server serves besides the API (paths match REPO_ROOT in app/main.py).
COPY frontend/ /app/frontend/
COPY sprites/ /app/sprites/
COPY sound-effects/ /app/sound-effects/

# Don't run as root.
RUN useradd --create-home scrimmagine && chown -R scrimmagine /app
USER scrimmagine

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/scenarios' % os.environ.get('PORT', '8000'), timeout=4)" || exit 1

# Hosts such as Cloud Run pass the port in $PORT; 8000 otherwise. One worker per container:
# each worker holds its own ~400 MB copy of the data, so scale with more containers instead.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
