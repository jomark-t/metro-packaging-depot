#!/bin/sh
set -e

# When a Fly.io volume is mounted at /data, redirect the SQLite DB and
# uploaded photos there so they survive redeploys/restarts. Without a
# mounted volume (e.g. building the image locally) this is a no-op and
# the app falls back to its normal local paths.
if [ -d /data ]; then
    mkdir -p /data/uploads
    rm -rf /app/static/uploads
    ln -s /data/uploads /app/static/uploads
    export DB_PATH=/data/schedule.db
fi

exec gunicorn -w 1 --threads 4 -b 0.0.0.0:8080 --timeout 120 app:app
