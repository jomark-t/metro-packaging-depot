FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && playwright install --with-deps chromium

COPY . .
RUN mkdir -p static/uploads

RUN chmod +x entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["./entrypoint.sh"]
