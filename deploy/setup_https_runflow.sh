#!/usr/bin/env bash
set -euo pipefail
DOMAIN=runflow.pro
IP=109.120.156.101
BASE=/home/aliveco/runflow

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash $BASE/deploy/setup_https_runflow.sh" >&2
  exit 1
fi

ensure_staging_conf() {
  if [ -f "$BASE/staging/conf.json" ]; then
    return
  fi
  cat > "$BASE/staging/conf.json" <<'JSON'
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
  chown aliveco:aliveco "$BASE/staging/conf.json"
}

resolved=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)
if [ "$resolved" != "$IP" ]; then
  echo "DNS is not ready: $DOMAIN resolves to '${resolved:-nothing}', expected $IP" >&2
  exit 2
fi
WWW_DOMAIN=www.$DOMAIN
www_resolved=$(getent ahostsv4 "$WWW_DOMAIN" | awk '{print $1; exit}' || true)
CERT_DOMAINS=(-d "$DOMAIN")
if [ "$www_resolved" = "$IP" ]; then
  CERT_DOMAINS+=( -d "$WWW_DOMAIN" )
else
  echo "WWW DNS is not ready or not used: $WWW_DOMAIN resolves to '${www_resolved:-nothing}'. Certificate will be issued only for $DOMAIN."
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx

python3 "$BASE/deploy/bin/prepare_domain_conf.py"

install -m 0644 "$BASE/deploy/systemd/runflow-product.service" /etc/systemd/system/runflow-product.service
install -m 0644 "$BASE/deploy/systemd/runflow-staging.service" /etc/systemd/system/runflow-staging.service
systemctl daemon-reload

# Stop legacy user-launched processes if present.
su - aliveco -c '/home/aliveco/runflow/stop_all.sh' || true
ensure_staging_conf

systemctl enable --now runflow-product.service runflow-staging.service

install -m 0644 "$BASE/deploy/nginx/runflow.pro.conf" /etc/nginx/sites-available/runflow.pro
ln -sfn /etc/nginx/sites-available/runflow.pro /etc/nginx/sites-enabled/runflow.pro
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

certbot --nginx "${CERT_DOMAINS[@]}" --redirect --agree-tos --no-eff-email -m admin@runflow.pro
systemctl reload nginx

echo "HTTPS is ready: https://runflow.pro"
