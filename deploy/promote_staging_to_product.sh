#!/usr/bin/env bash
set -euo pipefail

BASE=/home/aliveco/runflow
STAGING=$BASE/staging
PRODUCT=$BASE/product
BACKUP=$BASE/backups/product-code-$(date +%Y%m%d-%H%M%S)
APP_PATTERN='[p]roduct/server.py'

ensure_staging_conf() {
  if [ -f "$STAGING/conf.json" ]; then
    return
  fi
  cat > "$STAGING/conf.json" <<'JSON'
{
  "server": {
    "host": "127.0.0.1",
    "port": 8766
  },
  "storage": {
    "databasePath": "data/training_coach.sqlite3"
  },
  "logging": {
    "file": "data/logs/training_coach.log",
    "level": "INFO",
    "maxBytes": 1048576,
    "backupCount": 5
  },
  "polar": {
    "enabled": false,
    "autoSync": false
  },
  "notifications": {
    "telegram": {
      "enabled": false,
      "pollCommands": false
    }
  },
  "auth": {
    "enabled": false
  }
}
JSON
}

mkdir -p "$BACKUP"
rsync -a --exclude conf.json --exclude data --exclude Workouts "$PRODUCT"/ "$BACKUP"/
ensure_staging_conf

rsync -a --delete   --exclude conf.json   --exclude data   --exclude Workouts   --exclude __pycache__   "$STAGING"/ "$PRODUCT"/

rm -f "$BASE/product.pid"
old_pid=$(pgrep -f "$APP_PATTERN" | head -1 || true)

if [ -n "$old_pid" ]; then
  kill "$old_pid" || true
elif command -v systemctl >/dev/null 2>&1 && systemctl is-enabled runflow-product.service >/dev/null 2>&1; then
  echo "product service is enabled; waiting for systemd to start it"
else
  "$BASE/start_product.sh"
fi

for _ in $(seq 1 30); do
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
