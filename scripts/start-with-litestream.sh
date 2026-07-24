#!/bin/sh
# Production entrypoint: restore the database from S3 if it's missing, then run
# the app under Litestream so every write is streamed back to S3.
#
# Use this instead of `npm start` on the server. It assumes the `litestream`
# binary is installed and litestream.yml is present (see the README deploy
# section). Run locally with plain `npm start` — no Litestream needed.
set -eu

CONFIG="${LITESTREAM_CONFIG:-litestream.yml}"
DB="${DATABASE_PATH:-/data/shop.db}"

# First boot on a fresh instance has no local file — pull the latest replica.
# `-if-replica-exists` makes the very first ever deploy (empty bucket) a no-op
# instead of an error; the app then seeds a new DB, which Litestream replicates.
if [ ! -f "$DB" ]; then
  echo "No database at $DB — restoring from S3 if a replica exists…"
  litestream restore -config "$CONFIG" -if-replica-exists "$DB"
fi

# Replicate continuously and supervise the app. Litestream forwards signals and
# exits with the app's status, so it behaves correctly under a process manager.
exec litestream replicate -config "$CONFIG" -exec "npm start"
