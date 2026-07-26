#!/bin/sh
# Production entrypoint for Lightsail (which can't assume an IAM role).
#
# Pulls the app's secrets from AWS Secrets Manager into the environment, then
# hands off to the Litestream entrypoint. The instance authenticates with a
# single bootstrap IAM user whose credentials are provided as AWS_ACCESS_KEY_ID /
# AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION (see the systemd EnvironmentFile in
# docs/aws-setup.md). Those same credentials cover Litestream's S3 access.
#
# SECRETS_ID names the secret, e.g. "glaze-shop/prod". The secret is a JSON blob
# like {"STRIPE_SECRET_KEY":"sk_live_…","STRIPE_WEBHOOK_SECRET":"whsec_…"}.
set -eu

: "${SECRETS_ID:?set SECRETS_ID to the Secrets Manager secret name}"

# Never trace this script — it handles secret material.
set +x

SECRET_JSON="$(aws secretsmanager get-secret-value \
  --secret-id "$SECRETS_ID" \
  --query SecretString --output text)"

# Export each key the app expects, if present. jq reads the value by name so no
# secret is ever placed on a command line or in the process list.
for KEY in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PUBLISHABLE_KEY; do
  VALUE="$(printf '%s' "$SECRET_JSON" | jq -r --arg k "$KEY" '.[$k] // empty')"
  [ -n "$VALUE" ] && export "$KEY=$VALUE"
done
unset SECRET_JSON

exec sh scripts/start-with-litestream.sh
