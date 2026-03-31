# Kiyeovo

> Beta notice: this is the beta version of Kiyeovo. Expect rough edges, missing polish, and behavior changes before the first full release.
> Tested on: Linux (Debian, Ubuntu, Lubuntu, EndeavourOS) and macOS.

Kiyeovo is a decentralized peer-to-peer messenger.

- realtime direct messages are end-to-end encrypted
- messages can fall back to offline delivery when the other side is not online
- `fast` mode is for normal day-to-day use: lower latency, relays, and 1:1 audio/video calling
- `anonymous` mode is for Tor-routed messaging. Better anonymity, but slower and less convenient
- group chats, encrypted file transfer, and trusted profile import/export
- no central account or message server; you can use the default bootstrap/relay setup or self-host (see the [guide](#bootstrap-and-relay-setup))

For technical readers, contributors, and coding agents, start with [Kiyeovo_desktop_technical_documentation.md](./Kiyeovo_desktop_technical_documentation.md). That is the source-of-truth architecture overview.


## Beta status

The purpose of this beta release is to gain feedback on the core app functionality and feel.

The full version will come with:

- big UX improvements
- group audio/video calls (fast mode)
- screen sharing in calls (fast mode)
- performance improvements
- security hardening
- easier self-hosted infrastructure setup
- local API interface for agents and external tools
- emojis 🪐

## Quick start

> If you want to try out the beta without self-hosting immediately, you can do that by connecting to one of my nodes listed [here](#connect-to-already-existing-nodes).
> There is also a tutorial [here](https://marindedic.com/blog/p2p-messenger/), but you can just follow the steps below

Requirements for running:

- Node.js 20+
- npm

Clone the repo:

```
git clone https://github.com/Realman78/kiyeovo-desktop.git
cd kiyeovo-desktop/
```

### Local non-dev run

```bash
npm run setup
npm run start:local
```

`npm run setup` installs dependencies and sets up Tor. If you only plan to use fast mode, `npm install` is enough.

### Local development / testing 

```bash
npm run setup
DEBUG_MODE=true npm run dev
```

> You can omit `DEBUG_MODE=true` if you don't plan on reporting any bugs

Technical detail: In the beta version, `npm run dev` starts Electron with `--no-sandbox`.

### Scrypt note (optional)

If your machine is not low-end, consider increasing `IDENTITY_SCRYPT_N` and `PROFILE_SCRYPT_N` in [src/core/constants.ts](./src/core/constants.ts) for stronger protection against local brute-force password attacks, but at the cost of slower unlock/import.

## Bootstrap and relay setup

### Fast mode

1. Install dependencies

```bash
ROLE=bootstrap npm install
```

2. Start a bootstrap node:

```bash
BOOTSTRAP_NETWORK_MODE=fast \
BOOTSTRAP_ANNOUNCE_ADDRS=/ip4/YOUR_PUBLIC_IP/tcp/9000 \
npm run bootstrap
```

3. Start a relay node:

```bash
RELAY_ANNOUNCE_ADDRS=/ip4/YOUR_PUBLIC_IP/tcp/4002 \
npm run relay
```

4. Make sure your firewall rules allow TCP on:

```text
9000  # bootstrap
4002  # relay
```

5. Each process prints its Peer ID. Add the client-facing addresses in Kiyeovo's Connection Status dialog:

```text
/ip4/YOUR_PUBLIC_IP/tcp/9000/p2p/<BOOTSTRAP_PEER_ID>
/ip4/YOUR_PUBLIC_IP/tcp/4002/p2p/<RELAY_PEER_ID>
```


### Anonymous mode

1. Run the setup script

```bash
ROLE=bootstrap npm run setup
```

2. Start a bootstrap node in anonymous mode:

```bash
BOOTSTRAP_NETWORK_MODE=anonymous \
BOOTSTRAP_ANNOUNCE_ADDRS=/onion3/YOUR_ONION_HOST:9000 \
npm run bootstrap
```

3. The bootstrap process itself still listens on local TCP port `9000`. Your onion service must forward that port to the bootstrap process.

4. Add the client-facing bootstrap address in Kiyeovo:

```text
/onion3/YOUR_ONION_HOST:9000/p2p/<BOOTSTRAP_PEER_ID>
```

The relay is not needed in anonymous mode.

### (Optional) STUN/TURN for calls in Fast mode

Calls are currently fast-mode direct 1:1 calls.

If you want to self-host calls, the simple path is:

1. Set up a TURN server such as coturn.
2. Open `3478` on UDP/TCP and a relay port range such as `49160-49200`.
3. In Kiyeovo, open `Connection status -> Calls` and add your STUN/TURN servers there.

You can add multiple ICE servers. Kiyeovo supports `stun`, `turn`, and `turns` entries.

Make sure your firewall rules allow traffic on:

```text
3478/tcp
3478/udp
49160-49200/tcp
49160-49200/udp
```

Minimal coturn example:

```conf
listening-port=3478
fingerprint
lt-cred-mech
realm=kiyeovo
user=kiyeovo:change-me
min-port=49160
max-port=49200
```

Then run `sudo systemctl enable --now coturn`

## Technical note

The desktop app is built with Electron, React, and libp2p.

## How this differs from similar solutions (roughly)

> This comparison reflects the current beta version. The final version differences may differ.

- Briar: Briar runs everything over Tor and also supports syncing via Bluetooth, Wi-Fi or memory cards. Kiyeovo instead has two separate, and completely isolated, network modes -> Fast (clearnet) and Anonymous (Tor) - you can choose between performance (and additional features) and anonymity
- Session: Session uses its own network of nodes to send and store messages. Kiyeovo uses pure libp2p and stores offline messages in the DHT - simpler, but not guaranteed "always-on".
- Tox: Tox runs as one global P2P network. Kiyeovo splits things into two separate networks depending on the mode.
- Ricochet: Ricochet is simple Tor-based messaging. Kiyeovo is more full-featured, with groups, offline messages, file transfer, and calls (in fast mode).

## Connect to already existing nodes

These nodes will be shut down on April 19th 2026.

1. Amsterdam
    - Bootstrap: /ip4/68.183.15.8/tcp/9000/p2p/12D3KooWEL2tNuaYNxKE9fh4KufvW9TnjzmnS1xBFdbUYtq8N5qx
    - Relay: /ip4/68.183.15.8/tcp/4002/p2p/12D3KooWRpVU72wHWFEQidYtNhGNvWNHq4rYgk4a8oy2gsEDitcU
    - STUN: stun:68.183.15.8:3478
    - TURN: turn:188.166.161.63:3478?transport=udp kiyeovo:marinparin