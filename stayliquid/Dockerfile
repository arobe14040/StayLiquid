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

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

EXPOSE 8099

CMD ["python3", "-m", "app.main"]
