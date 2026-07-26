#!/usr/bin/env bash
# Provision one environment (test or prod) on AWS from your laptop.
#
#   ./scripts/aws/provision-env.sh test
#   ./scripts/aws/provision-env.sh prod
#
# Creates, for the named environment: an S3 bucket (Litestream backups), a
# Secrets Manager secret (Stripe keys, placeholder), a least-privilege IAM user +
# access key, and a Lightsail instance with a static IP, an attached data disk,
# and ports 80/443 open. It then writes ./glaze-shop-<env>.env locally with
# everything the instance needs, and prints the handoff commands for
# bootstrap-instance.sh.
#
# Idempotent: re-running skips resources that already exist. The one exception is
# the IAM access key (a new one can't reveal an old secret) — see the note below.
#
# Requires: awscli v2, configured with credentials that can create these
# resources (an admin/poweruser profile). Nothing here is run against the shop's
# runtime IAM user — that user is created here.
#
# Overrides via environment: REGION (default us-east-1), BUNDLE (Lightsail size,
# default micro_3_0), DISK_GB (default 8), DOMAIN (default: an sslip.io hostname
# derived from the static IP), AWS_PROFILE (standard awscli).
set -euo pipefail

ENV="${1:-}"
case "$ENV" in
  test|prod) ;;
  *) echo "usage: $0 <test|prod>" >&2; exit 2 ;;
esac

REGION="${REGION:-us-east-1}"
BUNDLE="${BUNDLE:-micro_3_0}"        # 1 GB RAM; nano_3_0 (512 MB) is tight for npm
DISK_GB="${DISK_GB:-8}"
AZ="${AZ:-${REGION}a}"

command -v aws >/dev/null || { echo "aws CLI not found — install awscli v2." >&2; exit 1; }

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "Account: $ACCOUNT_ID   Region: $REGION   Env: $ENV"

NAME="glaze-shop-$ENV"
BUCKET="glaze-shop-backups-$ENV-$ACCOUNT_ID"   # account id keeps it globally unique + idempotent
SECRET_NAME="glaze-shop/$ENV"
POLICY_NAME="glaze-shop-$ENV-policy"
USER_NAME="glaze-shop-$ENV"
IP_NAME="$NAME-ip"
DISK_NAME="$NAME-data"

cat <<PLAN

About to create (region $REGION):
  S3 bucket            $BUCKET
  Secrets Manager      $SECRET_NAME            (placeholder — you set the real Stripe key after)
  IAM policy + user    $POLICY_NAME / $USER_NAME
  Lightsail instance   $NAME  ($BUNDLE, Ubuntu 22.04)
  Static IP            $IP_NAME
  Data disk            $DISK_NAME  (${DISK_GB} GB)  → /dev/xvdf
  Firewall             open 80, 443

These are billable (~\$7-15/mo for this env).
PLAN
if [ "${YES:-}" != "1" ]; then
  printf "Proceed? [y/N] "; read -r ans; [ "$ans" = "y" ] || { echo "aborted."; exit 1; }
fi

# ── S3 bucket ─────────────────────────────────────────────────────────
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "· bucket exists: $BUCKET"
else
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  echo "· created bucket: $BUCKET"
fi

# ── Secrets Manager secret (placeholder) ──────────────────────────────
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "· secret exists: $SECRET_NAME (leaving its value untouched)"
else
  aws secretsmanager create-secret --name "$SECRET_NAME" --region "$REGION" \
    --secret-string '{"STRIPE_SECRET_KEY":"REPLACE_ME","STRIPE_WEBHOOK_SECRET":"REPLACE_ME"}' >/dev/null
  echo "· created secret: $SECRET_NAME (placeholder values)"
fi
SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" --query ARN --output text)"

# ── IAM policy + user + access key ────────────────────────────────────
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"
POLICY_DOC="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "LitestreamBucket", "Effect": "Allow", "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${BUCKET}" },
    { "Sid": "LitestreamObjects", "Effect": "Allow",
      "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*" },
    { "Sid": "ReadStripeSecret", "Effect": "Allow", "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "${SECRET_ARN}" }
  ]
}
JSON
)"
if aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  echo "· policy exists: $POLICY_NAME"
else
  aws iam create-policy --policy-name "$POLICY_NAME" --policy-document "$POLICY_DOC" >/dev/null
  echo "· created policy: $POLICY_NAME"
fi

if aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  echo "· user exists: $USER_NAME"
else
  aws iam create-user --user-name "$USER_NAME" >/dev/null
  echo "· created user: $USER_NAME"
fi
aws iam attach-user-policy --user-name "$USER_NAME" --policy-arn "$POLICY_ARN"

# An access key's secret is shown only at creation. Reuse an existing key if one
# is already present (you kept it in the env file); otherwise mint one.
EXISTING_KEYS="$(aws iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[].AccessKeyId' --output text)"
if [ -n "$EXISTING_KEYS" ]; then
  echo "· user already has an access key ($EXISTING_KEYS)."
  echo "  Reusing the values from an existing ./glaze-shop-$ENV.env if present;"
  echo "  otherwise rotate: aws iam delete-access-key --user-name $USER_NAME --access-key-id $EXISTING_KEYS, then re-run."
  AK=""; SK=""
  if [ -f "./glaze-shop-$ENV.env" ]; then
    AK="$(grep -E '^AWS_ACCESS_KEY_ID=' "./glaze-shop-$ENV.env" | cut -d= -f2- || true)"
    SK="$(grep -E '^AWS_SECRET_ACCESS_KEY=' "./glaze-shop-$ENV.env" | cut -d= -f2- || true)"
  fi
else
  # --output text returns the two fields tab-separated, on one line.
  KEY_PAIR="$(aws iam create-access-key --user-name "$USER_NAME" \
    --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)"
  AK="$(printf '%s' "$KEY_PAIR" | awk '{print $1}')"
  SK="$(printf '%s' "$KEY_PAIR" | awk '{print $2}')"
  echo "· created access key: $AK"
fi

# ── Lightsail instance ────────────────────────────────────────────────
if aws lightsail get-instance --instance-name "$NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "· instance exists: $NAME"
else
  aws lightsail create-instances --instance-names "$NAME" --availability-zone "$AZ" \
    --blueprint-id ubuntu_22_04 --bundle-id "$BUNDLE" --region "$REGION" >/dev/null
  echo "· creating instance: $NAME (waiting for it to run)…"
fi
# Wait until running.
for _ in $(seq 1 60); do
  STATE="$(aws lightsail get-instance --instance-name "$NAME" --region "$REGION" --query 'instance.state.name' --output text 2>/dev/null || echo pending)"
  [ "$STATE" = "running" ] && break
  sleep 5
done
echo "· instance state: ${STATE:-unknown}"

# ── Static IP ─────────────────────────────────────────────────────────
if aws lightsail get-static-ip --static-ip-name "$IP_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "· static IP exists: $IP_NAME"
else
  aws lightsail allocate-static-ip --static-ip-name "$IP_NAME" --region "$REGION" >/dev/null
fi
aws lightsail attach-static-ip --static-ip-name "$IP_NAME" --instance-name "$NAME" --region "$REGION" >/dev/null 2>&1 || true
STATIC_IP="$(aws lightsail get-static-ip --static-ip-name "$IP_NAME" --region "$REGION" --query 'staticIp.ipAddress' --output text)"
echo "· static IP: $STATIC_IP"

# ── Data disk ─────────────────────────────────────────────────────────
if aws lightsail get-disk --disk-name "$DISK_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "· disk exists: $DISK_NAME"
else
  aws lightsail create-disk --disk-name "$DISK_NAME" --availability-zone "$AZ" \
    --size-in-gb "$DISK_GB" --region "$REGION" >/dev/null
  for _ in $(seq 1 30); do
    DSTATE="$(aws lightsail get-disk --disk-name "$DISK_NAME" --region "$REGION" --query 'disk.state' --output text 2>/dev/null || echo pending)"
    [ "$DSTATE" = "available" ] && break; sleep 3
  done
fi
aws lightsail attach-disk --disk-name "$DISK_NAME" --instance-name "$NAME" \
  --disk-path /dev/xvdf --region "$REGION" >/dev/null 2>&1 || true
echo "· disk attached at /dev/xvdf"

# ── Firewall ──────────────────────────────────────────────────────────
aws lightsail open-instance-public-ports --instance-name "$NAME" --region "$REGION" \
  --port-info fromPort=80,toPort=80,protocol=TCP >/dev/null 2>&1 || true
aws lightsail open-instance-public-ports --instance-name "$NAME" --region "$REGION" \
  --port-info fromPort=443,toPort=443,protocol=TCP >/dev/null 2>&1 || true
echo "· opened ports 80, 443"

# SSH (22): restrict to SSH_CIDR if given, else leave at the Lightsail default
# (open to the world, key-only). Pass SSH_CIDR=auto to lock it to your current IP.
if [ -n "${SSH_CIDR:-}" ]; then
  if [ "$SSH_CIDR" = "auto" ]; then
    SSH_CIDR="$(curl -fsS https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')/32"
  fi
  aws lightsail open-instance-public-ports --instance-name "$NAME" --region "$REGION" \
    --port-info "fromPort=22,toPort=22,protocol=TCP,cidrs=${SSH_CIDR}" >/dev/null 2>&1 || true
  echo "· SSH (22) restricted to ${SSH_CIDR}"
else
  echo "· SSH (22) left open to 0.0.0.0/0 (Lightsail default). Set SSH_CIDR=auto or x.x.x.x/32 to restrict."
fi

# ── Hostname / PUBLIC_URL ─────────────────────────────────────────────
HOSTNAME_DEFAULT="$(printf '%s' "$STATIC_IP" | tr '.' '-').sslip.io"
HOST="${DOMAIN:-$HOSTNAME_DEFAULT}"
PUBLIC_URL="https://$HOST"

# ── Write the instance env file ───────────────────────────────────────
ENV_FILE="./glaze-shop-$ENV.env"
if [ -n "${AK:-}" ] && [ -n "${SK:-}" ]; then
  umask 077
  cat > "$ENV_FILE" <<ENVOUT
# Generated by provision-env.sh for the "$ENV" environment. Contains the bootstrap
# IAM key — keep it out of git (it is gitignored) and off shared machines.
AWS_ACCESS_KEY_ID=$AK
AWS_SECRET_ACCESS_KEY=$SK
AWS_DEFAULT_REGION=$REGION

SECRETS_ID=$SECRET_NAME
LITESTREAM_S3_BUCKET=$BUCKET
LITESTREAM_S3_REGION=$REGION

DATABASE_PATH=/data/shop.db
PUBLIC_URL=$PUBLIC_URL
PORT=4242

# Optional site password (Caddy basic-auth) — protects everything except /webhook.
# Generate the hash on the instance:  caddy hash-password
# Keep the hash SINGLE-QUOTED (it contains \$). Uncomment both to enable:
# BASIC_AUTH_USER=admin
# BASIC_AUTH_HASH='REPLACE_WITH_caddy_hash-password_OUTPUT'
ENVOUT
  echo "· wrote $ENV_FILE"
else
  echo "· NOTE: could not write access-key values (reused existing key). Edit $ENV_FILE by hand if needed."
fi

cat <<NEXT

────────────────────────────────────────────────────────────────────
Done provisioning "$ENV".

1. Put your real Stripe key in the secret:
   aws secretsmanager put-secret-value --secret-id $SECRET_NAME --region $REGION \\
     --secret-string '{"STRIPE_SECRET_KEY":"sk_...","STRIPE_WEBHOOK_SECRET":"REPLACE_ME"}'
   (Set STRIPE_WEBHOOK_SECRET later, after registering the webhook at $PUBLIC_URL/webhook.)

2. Get the SSH key for this region (once). The privateKeyBase64 field is already
   PEM text, so write it straight to the file — do NOT base64-decode it:
   aws lightsail download-default-key-pair --region $REGION \\
     --query privateKeyBase64 --output text > lightsail-$REGION.pem
   chmod 600 lightsail-$REGION.pem

3. Copy the env file and bootstrap the instance:
   scp -i lightsail-$REGION.pem $ENV_FILE ubuntu@$STATIC_IP:/tmp/glaze-shop.env
   ssh -i lightsail-$REGION.pem ubuntu@$STATIC_IP \\
     'curl -fsSL https://raw.githubusercontent.com/stellacheng98/amaco-glazes-shop/main/scripts/aws/bootstrap-instance.sh | bash'

App will come up at: $PUBLIC_URL
────────────────────────────────────────────────────────────────────
NEXT
