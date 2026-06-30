#!/bin/sh
set -eu

# Tor entrypoint for the Kiyeovo anonymous bootstrap onion service.
#
# Tor requires its DataDirectory / HiddenServiceDir to be owned by the tor user
# and mode 0700. As root we fix ownership of the (bind-mounted, persistent) data
# dir, then drop to debian-tor. The .onion hostname is public (it is the address
# clients dial), so once Tor generates it we copy it to a shared path the
# bootstrap container reads — the secret keys never leave the 0700 dir. The
# shared path is a host-managed bind mount (cleared by the CLI on `up`), so a
# stale hostname from a previous deployment can't be read before Tor republishes.

HS_DIR=/var/lib/tor/kiyeovo-bootstrap
SHARED_HOSTNAME="${KIYEOVO_ONION_HOSTNAME_FILE:-/run/onion/hostname}"
SHARED_DIR="$(dirname "$SHARED_HOSTNAME")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$HS_DIR" "$SHARED_DIR"
  chown -R debian-tor:debian-tor /var/lib/tor
  chmod 700 "$HS_DIR"
  # Ensure debian-tor can publish the (public) hostname even if the shared dir
  # was created root-owned by Docker. World-writable is fine: it holds only the
  # public .onion address, and keeping it non-tor-owned lets the host CLI clear
  # the hostname between deployments.
  chmod 0777 "$SHARED_DIR"
  exec gosu debian-tor:debian-tor "$0" "$@"
fi

# Running as debian-tor. Forward shutdown signals to the Tor process so the
# container stops promptly and cleanly.
tor_pid=''
trap 'if [ -n "$tor_pid" ]; then kill -TERM "$tor_pid" 2>/dev/null || true; fi' TERM INT

# Defensively clear any stale published hostname before generating a fresh one,
# so a republished onion always reflects the current keys in HS_DIR.
rm -f "$SHARED_HOSTNAME" 2>/dev/null || true

tor -f /etc/tor/torrc &
tor_pid=$!

waited=0
while [ ! -s "$HS_DIR/hostname" ]; do
  waited=$((waited + 1))
  if [ "$waited" -gt 60 ]; then
    echo "tor-entrypoint: onion hostname was not generated within 60s" >&2
    kill "$tor_pid" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

cp "$HS_DIR/hostname" "$SHARED_HOSTNAME"
chmod 644 "$SHARED_HOSTNAME"
echo "tor-entrypoint: published onion $(cat "$SHARED_HOSTNAME")"

wait "$tor_pid"
