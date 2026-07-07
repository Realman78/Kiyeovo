# Kiyeovo Launch Checklist Notes

Yes, connect the bootstrap nodes, but not because they will "have the same DHT state." Kademlia does not fully sync every record to every bootstrap. The goal is to avoid a partitioned cold start: each bootstrap should know several same-mode bootstrap peers so clients entering through any one node can route into the same network.

## Most Urgent Launch Items

1. Ship default infrastructure in the app.

   Right now `src/core/network/default-infrastructure.ts` has empty bootstrap and relay defaults. If users should run without setup, the release build needs default bootstrap addresses and fast relay addresses.

2. Keep the public default bootstrap list to 6 or patch the cap.

   The client currently caps bootstrap candidates at 6 in `src/core/network/node-bootstrap.ts`, and targets 3 fast-mode bootstrap connections in `src/core/constants.ts`. If you boot 7-8 nodes but ship all as defaults, the later entries may not help first-run users.

3. Include relays, not only bootstraps.

   Bootstraps help DHT discovery and offline records. Relays are what make fast-mode NAT traversal more reliable. For launch, I would run 4-6 bootstraps, 2-4 relays, and optionally one TURN server if calls matter.

4. Use stable DNS multiaddrs and preserve Peer IDs.

   Default nodes are inserted only once per user database in `src/core/db/database.ts`, so broken default addresses are annoying to recover from. Back up each bootstrap and relay identity key. Do not round-robin multiple Peer IDs behind one `/p2p/<peerId>` address.

5. Interconnect bootstraps same-mode only.

   Do not share or copy Level datastores. Do not connect fast and anonymous bootstraps together. Ideally add a small bootstrap-server env var like `BOOTSTRAP_PEER_ADDRS` so each bootstrap dials the others on startup. Otherwise use an ops warmup script, but do not rely on random clients to bridge them.

## DoS Protection

Keep this boring:

- Use provider firewall and DDoS protection.
- Rate-limit new inbound TCP connections.
- Set CPU, memory, and disk limits on containers.
- Monitor datastore growth.
- Monitor process restarts.
- Alert on port health.

The bootstrap server currently has `maxConnections: 500`. I would consider adding the same inbound connection and pending-upgrade caps used by client nodes, but only if you can test it quickly before launch.

## Other Launch Checklist Items

- Set a real app version; `package.json` is still `0.0.0`.
- Produce hashes for every installer, AppImage, and infra bundle.
- Test clean install on each target OS, not just dev runs.
- Test two users on different networks: register, find by username, online message, offline message, file, group invite, and restart recovery.
- Test no-config first run against the public infrastructure.
- Update the README: it still says public bootstrap and relay nodes are temporarily offline and mentions outdated docs.
- Have a hotfix path ready: tag release, keep build machine and environment reproducible, and know how you will publish `0.1.1`.
- Be explicit on HN that it is beta, P2P, and not a mature audited secure messenger. Overclaiming security will attract the wrong kind of scrutiny.

