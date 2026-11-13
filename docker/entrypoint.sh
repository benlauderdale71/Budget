#!/bin/sh
set -eu

# Production must not silently fall back to an ephemeral embedded database.
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required for the production container." >&2
  exit 1
fi

# Railway mounts the persistent volume at runtime. Prepare its upload directory
# before dropping privileges; the application itself runs as the node user.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${BUDGETCENTS_UPLOADS:-/data/uploads}"
  chown node:node "${BUDGETCENTS_UPLOADS:-/data/uploads}"
  exec gosu node "$@"
fi

exec "$@"
