#!/usr/bin/env bash
# Bootstrap a freshly provisioned Lightsail instance into a running shop.
#
# Run ON the instance (as the default `ubuntu` user), after provision-env.sh has
# copied the env file to /tmp/glaze-shop.env:
#
#   curl -fsSL https://raw.githubusercontent.com/stellacheng98/amaco-glazes-shop/main/scripts/aws/bootstrap-instance.sh | bash
#
# It installs Node/Litestream/Caddy/etc, mounts the data disk, clones the app,
# installs the systemd service and Caddy config, seeds the catalog, and starts
# everything. Idempotent and safe to re-run — in particular it NEVER reformats a
# disk that already holds a filesystem.
set -euo pipefail

SRC_ENV="${SRC_ENV:-/tmp/glaze-shop.env}"
[ -f "$SRC_ENV" ] || { echo "Missing $SRC_ENV — scp the generated glaze-shop-<env>.env there first." >&2; exit 1; }

# Load config for this script's own use (PUBLIC_URL, SECRETS_ID, AWS_* …).
set -a; . "$SRC_ENV"; set +a
: "${PUBLIC_URL:?PUBLIC_URL missing from env file}"
: "${SECRETS_ID:?SECRETS_ID missing from env file}"
HOST="${PUBLIC_URL#https://}"; HOST="${HOST#http://}"

APP_DIR="/home/ubuntu/amaco-glazes-shop"
REPO="https://github.com/stellacheng98/amaco-glazes-shop.git"
DATA_DEVICE="${DATA_DEVICE:-/dev/xvdf}"

echo "── Installing packages ──────────────────────────────────────────"
sudo apt-get update -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3 jq unzip git

# AWS CLI v2 (skip if already present)
if ! command -v aws >/dev/null; then
  curl -s "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip
  ( cd /tmp && unzip -oq awscliv2.zip && sudo ./aws/install --update )
fi

# Litestream (pick arch). The .deb asset name includes the release version, so
# resolve the real download URL from the GitHub API rather than guessing a fixed
# "latest/download" path (which 404s). jq was installed above.
if ! command -v litestream >/dev/null; then
  # Litestream spells amd64 as "x86_64" in its asset names.
  case "$(uname -m)" in
    x86_64)        LS_ARCH=x86_64 ;;
    aarch64|arm64) LS_ARCH=arm64 ;;
    armv7l)        LS_ARCH=armv7 ;;
    *)             LS_ARCH=x86_64 ;;
  esac
  LS_URL="$(curl -fsSL https://api.github.com/repos/benbjohnson/litestream/releases/latest \
    | jq -r --arg a "linux-${LS_ARCH}.deb" '.assets[] | select(.name|endswith($a)) | .browser_download_url' | head -1)"
  # Fall back to a pinned release if the API is unreachable or rate-limited
  # (unauthenticated GitHub API is 60 req/hr per IP).
  if [ -z "$LS_URL" ]; then
    LS_VER=0.5.15
    LS_URL="https://github.com/benbjohnson/litestream/releases/download/v${LS_VER}/litestream-${LS_VER}-linux-${LS_ARCH}.deb"
    echo "· GitHub API returned no asset (rate limit?) — falling back to litestream ${LS_VER}"
  fi
  curl -fL "$LS_URL" -o /tmp/ls.deb
  sudo dpkg -i /tmp/ls.deb
fi

# Caddy (official repo)
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y caddy
fi

echo "── Mounting data disk at /data ──────────────────────────────────"
if [ ! -b "$DATA_DEVICE" ]; then
  echo "Device $DATA_DEVICE not found. Current block devices:"; lsblk
  echo "Set DATA_DEVICE and re-run." >&2; exit 1
fi
# Format ONLY if the device (and its children) have no filesystem and no mount.
if lsblk -rno FSTYPE,MOUNTPOINT "$DATA_DEVICE" | grep -q '[^[:space:]]'; then
  echo "· $DATA_DEVICE already has a filesystem/mount — not reformatting."
else
  echo "· formatting empty $DATA_DEVICE as ext4"
  sudo mkfs -t ext4 "$DATA_DEVICE"
fi
sudo mkdir -p /data
mountpoint -q /data || sudo mount "$DATA_DEVICE" /data
grep -q "^$DATA_DEVICE[[:space:]]*/data" /etc/fstab || \
  echo "$DATA_DEVICE /data ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab >/dev/null
sudo chown ubuntu:ubuntu /data

echo "── Installing the app ───────────────────────────────────────────"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev

echo "── Installing the runtime env file ──────────────────────────────"
sudo install -m 600 -o root -g root "$SRC_ENV" /etc/glaze-shop.env

echo "── systemd service ──────────────────────────────────────────────"
sudo tee /etc/systemd/system/glaze-shop.service >/dev/null <<UNIT
[Unit]
Description=Sample Glaze Co.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/glaze-shop.env
ExecStart=$APP_DIR/scripts/start-with-secrets.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

echo "── Caddy (automatic HTTPS for $HOST) ────────────────────────────"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$HOST {
    reverse_proxy localhost:4242
}
CADDY
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "── Seeding catalog (if the Stripe key is set) ───────────────────"
STRIPE_KEY="$(aws secretsmanager get-secret-value --secret-id "$SECRETS_ID" \
  --query SecretString --output text | jq -r '.STRIPE_SECRET_KEY // empty')"
if [ -n "$STRIPE_KEY" ] && [ "$STRIPE_KEY" != "REPLACE_ME" ]; then
  STRIPE_SECRET_KEY="$STRIPE_KEY" npm run sync-catalog
else
  echo "· Stripe key still a placeholder — skipping sync-catalog. Set the real key in"
  echo "  Secrets Manager ($SECRETS_ID), then run: cd $APP_DIR && STRIPE_SECRET_KEY=\$(...) npm run sync-catalog"
fi

echo "── Starting the service ─────────────────────────────────────────"
sudo systemctl daemon-reload
sudo systemctl enable --now glaze-shop
sleep 2
sudo systemctl --no-pager --full status glaze-shop | head -n 12

cat <<DONE

Bootstrap complete. The app is served at: $PUBLIC_URL
  logs:     journalctl -u glaze-shop -f
  restart:  sudo systemctl restart glaze-shop

Remaining once-off steps:
  · Register the Stripe webhook at $PUBLIC_URL/webhook (event checkout.session.completed),
    put its whsec_… into Secrets Manager ($SECRETS_ID) as STRIPE_WEBHOOK_SECRET,
    then: sudo systemctl restart glaze-shop
  · Restore drill (prove the backup): see docs/aws-setup.md step 10.
DONE
