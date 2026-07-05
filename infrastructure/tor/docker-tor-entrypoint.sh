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
  # was created root-owned by Docker. It holds only the public .onion address,
  # never secrets. Use a sticky world-writable directory (like /tmp) so unrelated
  # local users cannot replace/remove each other's files.
  chmod 1777 "$SHARED_DIR"
  # Clear stale hostname state while still root; with the sticky bit set,
  # debian-tor may not be able to remove a host-owned file.
  rm -f "$SHARED_HOSTNAME" "$SHARED_HOSTNAME".tmp.* 2>/dev/null || true
  exec gosu debian-tor:debian-tor "$0" "$@"
fi

# Running as debian-tor. Forward shutdown signals to the Tor process so the
# container stops promptly and cleanly.
tor_pid=''
trap 'if [ -n "$tor_pid" ]; then kill -TERM "$tor_pid" 2>/dev/null || true; fi' TERM INT

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

tmp_hostname="$SHARED_HOSTNAME.tmp.$$"
cp "$HS_DIR/hostname" "$tmp_hostname"
chmod 644 "$tmp_hostname"
mv -f "$tmp_hostname" "$SHARED_HOSTNAME"
echo "tor-entrypoint: published onion $(cat "$SHARED_HOSTNAME")"

wait "$tor_pid"
