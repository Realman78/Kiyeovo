#!/bin/sh
set -eu

# Kiyeovo server entrypoint.
#
# Role selects which server to run; provided as the first argument by compose
# (the image CMD defaults to "bootstrap"). Falls back to KIYEOVO_ROLE.
ROLE="${1:-${KIYEOVO_ROLE:-bootstrap}}"

DATA_DIR="${KIYEOVO_DATA_DIR:-/data}"
RUNTIME_DIR="${KIYEOVO_RUNTIME_DIR:-/run/kiyeovo}"

# When started as root, ensure the bind-mounted directories exist and are owned
# by the unprivileged service user, then re-exec this script as that user. The
# long-running server therefore never runs as root.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$RUNTIME_DIR"
  chown -R kiyeovo:kiyeovo "$DATA_DIR" "$RUNTIME_DIR"
  exec gosu kiyeovo:kiyeovo "$0" "$ROLE"
fi

case "$ROLE" in
  bootstrap) exec node /app/dist-server/core/bootstrap.js ;;
  relay)     exec node /app/dist-server/core/relay.js ;;
  *)
    echo "docker-entrypoint: unknown role '$ROLE' (expected 'bootstrap' or 'relay')" >&2
    exit 64
    ;;
esac
