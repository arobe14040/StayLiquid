ARG BUILD_FROM
FROM ${BUILD_FROM}

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY web ./web

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

EXPOSE 8099

CMD ["python3", "-m", "app.main"]
