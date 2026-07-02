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


<img width="1274" height="739" alt="image" src="https://github.com/user-attachments/assets/787f23da-9317-4e70-a44b-cdf504163e8f" />


## Beta status

The purpose of this beta release is to gain feedback on the core app functionality and feel.

The full version will come with:

- big UX improvements
- group audio/video calls (fast mode)
- screen sharing in calls *(Added 12th of May)*
- performance improvements
- security hardening *(Electron hardening added 11th of May)*
- easier self-hosted infrastructure setup
- local API interface for agents and external tools
- emojis 🪐 *(Added 12th of April)*
- Platform-specific installers

## Quick start

> The default public bootstrap/relay nodes are temporarily offline. To run the beta, see [Bootstrap and relay setup](#bootstrap-and-relay-setup) for self-hosting your own infrastructure.

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

Technical detail: local and development runs now use Electron renderer sandboxing.

#### Linux sandbox helper for development

On some Linux VMs/distros (for example, Lubuntu), unpackaged Electron may fail to start with a `chrome-sandbox` ownership/mode error:

```bash
The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that .../Kiyeovo/node_modules/electron/dist/chrome-sandbox is owned by root and has mode 4755.
```

This marks Chromium's small Linux sandbox helper as setuid-root so Electron can create sandbox boundaries and then run the app as your normal user.

For local development, fix it once after installing dependencies:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Verify that the helper is root-owned and has the setuid bit:

```bash
ls -l node_modules/electron/dist/chrome-sandbox
```

The output should start with something like `-rwsr-xr-x 1 root root`. You may need to repeat this after deleting or reinstalling `node_modules`. This should not be automated in `postinstall`; production Linux installs should handle sandbox setup through proper distro/package installer behavior.

### Scrypt note (optional)

If your machine is not low-end, consider increasing `IDENTITY_SCRYPT_N` and `PROFILE_SCRYPT_N` in [src/core/constants.ts](./src/core/constants.ts) for stronger protection against local brute-force password attacks, but at the cost of slower unlock/import.

## Bootstrap and relay setup

The recommended way to self-host is the **`kiyeovo-infra` CLI** in
`infrastructure/`. It runs the bootstrap, relay, optional Tor onion (anonymous
mode), and optional coturn TURN server as pinned Docker containers, owns their
lifecycle (start/stop/restart/auto-restart) through Docker Compose, and prints the
exact addresses to paste into Kiyeovo's Setup pages. You do not need to clone the
repo or install Node — a released bundle ships the CLI + compose files + systemd
templates and pulls the published images.

### Recommended: `kiyeovo-infra` (Docker)

Prerequisites: Docker Engine + the Compose plugin.

```bash
cd infrastructure          # or unpack the released kiyeovo-infra-<version>.tar.gz

./kiyeovo-infra fast init       # Fast: bootstrap + relay; can also configure TURN
./kiyeovo-infra fast firewall   # prints the ports to open (makes no changes)
./kiyeovo-infra fast up         # start Fast mode
./kiyeovo-infra fast status     # check health
./kiyeovo-infra fast addresses  # copy the printed multiaddrs into Kiyeovo
```

- **Fast mode** runs bootstrap + relay (and optional TURN); **anonymous mode**
  runs a Tor onion bootstrap (no relay, nothing published on the host).
- To run anonymous mode too, use the same commands with `anonymous`, for example
  `./kiyeovo-infra anonymous init`, `./kiyeovo-infra anonymous up`, and
  `./kiyeovo-infra anonymous addresses`. Both modes can coexist on one host; the
  CLI stores their state separately under `infrastructure/instances/fast/` and
  `infrastructure/instances/anon/`.
- If only one mode exists, the mode token may be omitted. Once both exist, name
  the mode explicitly so the CLI never guesses which stack you meant.
- For reboot survival: `sudo systemctl enable docker` (the containers use
  `restart: unless-stopped`).
- Operators who do not want Docker can use the advanced manual path below; the
  same servers can also run under systemd via the templates in
  `infrastructure/config/`.

### Advanced: manual setup (no Docker)

The steps below run the servers by hand and are the alternative to the CLI above.

#### Fast mode

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

5. You should be all set now. To register the servers in Kiyeovo, open the **Setup** tab in the left sidebar rail, then add each multiaddress with **Add server** — the bootstrap address under **Bootstrap servers** and the relay address under **Relay servers**:

```text
/ip4/YOUR_PUBLIC_IP/tcp/9000/p2p/<BOOTSTRAP_PEER_ID>
/ip4/YOUR_PUBLIC_IP/tcp/4002/p2p/<RELAY_PEER_ID>
```


#### Anonymous mode

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

5. The setup is done. To register the server in Kiyeovo, open the **Setup** tab in the left sidebar rail, go to **Bootstrap servers**, and add the address with **Add server**:

```text
/onion3/YOUR_ONION_HOST:9000/p2p/<BOOTSTRAP_PEER_ID>
```

The relay is not needed in anonymous mode.

#### (Optional) STUN/TURN for calls in Fast mode

Calls are currently fast-mode direct 1:1 calls.

If you want to self-host calls, a simple path is outlined below. Keep in mind, depending on your and the other party's router setting, you might not even need the TURN server.

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

4. The servers should be running now. To register them in Kiyeovo, open the **Setup** tab in the left sidebar rail and go to **STUN/TURN servers**, then add each entry with **Add server**.

You can add multiple ICE servers. Kiyeovo supports `stun`, `turn`, and `turns` entries.

## Technical note

The desktop app is built with Electron, React, and libp2p.

## How this differs from similar solutions (roughly)

> This comparison reflects the current beta version. The final version differences may differ.

- Briar: Briar runs everything over Tor and also supports syncing via Bluetooth, Wi-Fi or memory cards. Kiyeovo instead has two separate, and completely isolated, network modes -> Fast (clearnet) and Anonymous (Tor) - you can choose between performance (and additional features) and anonymity
- Session: Session uses its own network of nodes to send and store messages. Kiyeovo uses pure libp2p and stores offline messages in the DHT - simpler, but not guaranteed "always-on".
- Tox: Tox runs as one global P2P network. Kiyeovo splits things into two separate networks depending on the mode.
- Ricochet: Ricochet is simple Tor-based messaging. Kiyeovo is more full-featured, with groups, offline messages, file transfer, and calls (in fast mode).
