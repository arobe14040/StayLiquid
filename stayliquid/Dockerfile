FROM python:3.12-alpine

LABEL \
    org.opencontainers.image.title="StayLiquid" \
    org.opencontainers.image.description="Sprinkler zone scheduling with lawn growth-stage presets and rain delay" \
    org.opencontainers.image.source="https://github.com/arobe14040/StayLiquid"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY web ./web

# Supervisor passes the version from config.yaml as a build arg, so the running
# app can report exactly which build it is without duplicating the number here.
ARG BUILD_VERSION=dev

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    APP_VERSION=$BUILD_VERSION

EXPOSE 8099

CMD ["python3", "-m", "app.main"]
