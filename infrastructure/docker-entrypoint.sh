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

# Anonymous mode: the announce address is the Tor onion, which only exists once
# the Tor container has generated it. Wait for the shared hostname, derive the
# /onion3/<host>:<port> announce, and export it before starting the bootstrap.
wait_for_onion_announce() {
  hostfile="$KIYEOVO_ONION_HOSTNAME_FILE"
  vport="${KIYEOVO_ONION_VIRTUAL_PORT:-9000}"
  max="${KIYEOVO_ONION_WAIT_SECONDS:-120}"

  waited=0
  while [ ! -s "$hostfile" ]; do
    if [ "$waited" -ge "$max" ]; then
      echo "docker-entrypoint: timed out waiting for onion hostname at $hostfile" >&2
      exit 1
    fi
    sleep 2
    waited=$((waited + 2))
  done

  host="$(tr -d '[:space:]' < "$hostfile")"
  host="${host%.onion}"
  case "$host" in
    *[!a-z2-7A-Z]*) echo "docker-entrypoint: onion host has invalid chars: $host" >&2; exit 1 ;;
  esac
  if [ "$(printf '%s' "$host" | wc -c)" -ne 56 ]; then
    echo "docker-entrypoint: onion host is not 56 base32 chars: $host" >&2
    exit 1
  fi

  BOOTSTRAP_ANNOUNCE_ADDRS="/onion3/$host:$vport"
  export BOOTSTRAP_ANNOUNCE_ADDRS
  echo "docker-entrypoint: onion announce = $BOOTSTRAP_ANNOUNCE_ADDRS"
}

case "$ROLE" in
  bootstrap)
    if [ -n "${KIYEOVO_ONION_HOSTNAME_FILE:-}" ]; then
      wait_for_onion_announce
    fi
    exec node /app/dist-server/core/bootstrap.js
    ;;
  relay) exec node /app/dist-server/core/relay.js ;;
  *)
    echo "docker-entrypoint: unknown role '$ROLE' (expected 'bootstrap' or 'relay')" >&2
    exit 64
    ;;
esac
