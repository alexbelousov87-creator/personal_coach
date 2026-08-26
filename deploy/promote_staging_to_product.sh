#!/usr/bin/env bash
set -euo pipefail

BASE=/home/aliveco/runflow
STAGING=$BASE/staging
PRODUCT=$BASE/product
BACKUP=$BASE/backups/product-code-$(date +%Y%m%d-%H%M%S)
APP_PATTERN=/home/aliveco/runflow/product/server.py

mkdir -p "$BACKUP"
rsync -a --exclude conf.json --exclude data --exclude Workouts "$PRODUCT"/ "$BACKUP"/

rsync -a --delete \
  --exclude conf.json \
  --exclude data \
  --exclude Workouts \
  --exclude __pycache__ \
  "$STAGING"/ "$PRODUCT"/

rm -f "$BASE/product.pid"

old_pid=$(pgrep -f "$APP_PATTERN" | head -1 || true)
if [ -n "$old_pid" ]; then
  kill "$old_pid" || true
fi

for _ in $(seq 1 20); do
  new_pid=$(pgrep -f "$APP_PATTERN" | head -1 || true)
  if [ -n "$new_pid" ] && [ "$new_pid" != "${old_pid:-}" ]; then
    echo "product restarted: $new_pid"
    echo "promoted staging to product; backup: $BACKUP"
    exit 0
  fi
  sleep 1
done

echo "product files promoted, but backend restart was not observed" >&2
exit 1