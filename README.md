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
git clone https://github.com/Realman78/Kiyeovo.git
cd Kiyeovo
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

The fast bootstrap listener defaults to `0.0.0.0:9000`. If you need a different local port, set `BOOTSTRAP_LISTEN_ADDRESS`.

3. Start a relay node (if you already ran `ROLE=bootstrap npm install`):

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

2. Install and start a Tor daemon on the host. Example on linux:

```
apt update
apt install tor
systemctl start tor
systemctl enable tor # if you want to enable it on startup
systemctl status tor # verify it's running
```

3. Configure a hidden service that forwards the public onion port to the local bootstrap listener. Example on linux - add the below config to `/etc/tor/torrc`:

```conf
HiddenServiceDir /var/lib/tor/kiyeovo-bootstrap/ # you will find your onion hostname here later
HiddenServicePort 9000 127.0.0.1:9001
```

After changes, restart the tor service: `systemctl restart tor`

Find your onion host: `cat /var/lib/tor/kiyeovo-bootstrap/hostname`

4. Start a bootstrap node in anonymous mode:

```bash
BOOTSTRAP_NETWORK_MODE=anonymous \
BOOTSTRAP_LISTEN_ADDRESS=/ip4/127.0.0.1/tcp/9001 \
BOOTSTRAP_ANNOUNCE_ADDRS=/onion3/YOUR_ONION_HOST:9000 \
npm run bootstrap
```

If you host both fast and anonymous bootstrap nodes on the same machine, keep fast mode on `0.0.0.0:9000` and anonymous mode on local `127.0.0.1:9001`.

5. Add the client-facing bootstrap address in Kiyeovo:

```text
/onion3/YOUR_ONION_HOST:9000/p2p/<BOOTSTRAP_PEER_ID>
```

The relay is not needed in anonymous mode.

### (Optional) STUN/TURN for calls in Fast mode

Calls are currently fast-mode direct 1:1 calls.

If you want to self-host calls, the simple path is:

1. Set up a TURN server such as coturn. Example on linux:
    - install coturn with `apt install coturn`
    - run `sed -i 's/^#TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn`
    - add the configuration below to `/etc/turnserver.conf`:
```
listening-port=3478
fingerprint
lt-cred-mech
realm=kiyeovo
user=USERNAME:PASSWORD
external-ip=PUBLIC_IP
min-port=49160
max-port=49200
no-cli
```

2. Set up firewall (if firewall is enabled)
    - ALLOW TCP and UDP on port 3478
    - ALLOW UDP on port range 49160:49200.
    - From before: if you are running bootstrap and relay, ALLOW TCP on ports 9000 (bootstrap) and 4002 (relay)

3. Run `systemctl enable --now coturn`

4. In Kiyeovo, open `Connection status -> Calls` and add your STUN/TURN servers there.

You can add multiple ICE servers. Kiyeovo supports `stun`, `turn`, and `turns` entries.

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

1. Frankfurt
    - Anonymous mode Bootstrap: Coming on April 1st 2026
    - Fast mode Bootstrap: /ip4/188.166.161.63/tcp/9000/p2p/12D3KooWHhZDapttnphEpmqA8EKa6S2petfdNQTtMKtpS7SuGs3n
    - Relay: /ip4/188.166.161.63/tcp/4002/p2p/12D3KooWJEDJPBEbX1EGvFCzEGRwivjGvKSbZJPuzoTWqfjkrHr6
    - STUN: stun:188.166.161.63
    - TURN: turn:188.166.161.63:3478?transport=udp kiyeovo:marinparin

2. Amsterdam
    - Anonymous mode Bootstrap: Coming on April 1st 2026
    - Fast mode Bootstrap: /ip4/68.183.15.8/tcp/9000/p2p/12D3KooWEL2tNuaYNxKE9fh4KufvW9TnjzmnS1xBFdbUYtq8N5qx
    - Relay: /ip4/68.183.15.8/tcp/4002/p2p/12D3KooWRpVU72wHWFEQidYtNhGNvWNHq4rYgk4a8oy2gsEDitcU
    - STUN: stun:68.183.15.8:3478
    - TURN: turn:68.183.15.8:3478?transport=udp kiyeovo:marinparin

3. New York
    - Anonymous mode Bootstrap: /onion3/yzwpxyhhydqka3zbip4om6ufhsbhoyp4bvzakimtj6eeqothaybrayyd:9000/p2p/12D3KooWDXLMQhUJQ3CQzhkQTwN8PiCYvdACfUXmV4tvdy79SfLp
    - Fast mode Bootstrap: /ip4/157.230.222.64/tcp/9000/p2p/12D3KooWRDGQrpo1rFBLuhjzkj5dX89u1UuRizKYcYtdwop3rc8V
    - Relay: /ip4/157.230.222.64/tcp/4002/p2p/12D3KooWBEEs9DJiBSExDYdT92FBeDuAnABrBQgN9WB6k98UAUPF
    - STUN: stun:157.230.222.64:3478
    - TURN: turn:157.230.222.64:3478?transport=udp kiyeovo:marinparin

4. San Francisco
    - Anonymous mode Bootstrap: Coming on April 1st 2026
    - Fast mode Bootstrap: Coming on April 1st 2026
    - Relay: Coming on April 1st 2026
    - STUN: Coming on April 1st 2026
    - TURN: Coming on April 1st 2026