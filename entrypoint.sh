#!/bin/sh
set -e

# When a Fly.io volume is mounted at /data, redirect uploaded photos
# there so they survive redeploys/restarts. Without a mounted volume
# (e.g. building the image locally) this is a no-op. The database
# itself lives in Postgres (DATABASE_URL), not on this volume.
if [ -d /data ]; then
    mkdir -p /data/uploads
    rm -rf /app/static/uploads
    ln -s /data/uploads /app/static/uploads
fi

exec gunicorn -w 2 --threads 4 -b 0.0.0.0:8080 --timeout 120 app:app
