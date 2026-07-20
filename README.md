# Kiyeovo

> Kiyeovo 1.0 is here. It's a single-developer project, so if something breaks or a platform isn't supported, [report it](https://github.com/Realman78/Kiyeovo/issues). For security reports, email doroxhr [at] gmail [dot] com.
>
> Tested on: Linux (Debian, Ubuntu, Lubuntu, EndeavourOS) and macOS.

Kiyeovo is a decentralized peer-to-peer communication app. It supports many features you would find in modern messaging applications, yet still stays fully decentralized & respects your privacy. No e-mail or any KYC data needed.

- realtime end-to-end encrypted messages
- Direct & group video and audio calls with screen sharing options
- messages securely persisted when the other side is not online
- group chats, group calls
- `fast` mode is for normal day-to-day use: lower latency, relays, audio/video calling
- `anonymous` mode is for Tor-routed messaging. Better anonymity, but slower and no call support
- encrypted file transfers
- trusted profile import/export
- identity backup
- no central account or message server; use trusted bootstrap/relay servers or self-host with the [guide](#bootstrap-and-relay-setup)



<img width="1531" height="829" alt="image" src="https://github.com/user-attachments/assets/2942b2e0-a215-40da-8709-a502b5ad911f" />

*Figure: Conversation*

<img width="1530" height="824" alt="Screen sharing demo" src="https://github.com/user-attachments/assets/5916ad1b-b17f-49fb-9601-ac7a0923bba7" />

*Figure: Screen sharing*




For technical readers, contributors, and coding agents, start with [Kiyeovo_desktop_technical_documentation.md](./Kiyeovo_desktop_technical_documentation.md). That is the source-of-truth architecture overview.

## Installation

Most people should just grab the appropriate installer from the [Releases page](https://github.com/Realman78/Kiyeovo/releases). If you run into issues, take a look at the [notes below](#general-installation-notes) that cover platform quirks you may hit with the released **1.0.0** installers. These are documented workarounds for OS-level packaging/security behavior, not app bugs. If you run into something not covered here, please [open an issue](https://github.com/Realman78/Kiyeovo/issues).

### Linux

Two Linux artifacts are published: `Kiyeovo_1.0.0_amd64.deb` and `Kiyeovo-1.0.0.AppImage`.

**Installing the .deb.** Install it with apt (this also pulls any dependencies):

```bash
sudo apt install ./Kiyeovo_1.0.0_amd64.deb
```

After that, the app should be installed and ready for use.

**Installing the AppImage**

```bash
chmod +x Kiyeovo-1.0.0.AppImage
./Kiyeovo-1.0.0.AppImage
```



### macOS

Download the build for your Mac:

- Apple Silicon: `Kiyeovo-1.0.0-arm64.dmg`
- Intel: `Kiyeovo-1.0.0-x64.dmg`

Open the DMG and drag Kiyeovo into Applications.

### Windows

Download `Kiyeovo Setup 1.0.0.exe` (installer; installs per-user by default, never asks for administrator rights) or the portable `Kiyeovo 1.0.0.exe` (no install, just run) from the Releases page, then run it.

### General installation notes

**AppImage**

**AppImage aborts with a** `chrome-sandbox` **SUID error.**  Options, in order of preference:

- Install the **.deb** instead (see above).
- Run with the sandbox disabled:

```bash
./Kiyeovo-1.0.0.AppImage --no-sandbox
```

- Or enable unprivileged user namespaces on your system (distro-specific).

**AppImage won't run without FUSE.** On newer Ubuntu/Debian the AppImage needs `libfuse2`:

```bash
sudo apt install libfuse2
```

Or run it without FUSE (extracts to a temp dir and runs):

```bash
./Kiyeovo-1.0.0.AppImage --appimage-extract-and-run
```

**macOS**

**First launch is blocked by macOS.** The 1.0 build is not notarized, so macOS may refuse the first launch with *"Kiyeovo can't be opened because Apple cannot check it for malicious software."* You only need to do this once: Depending on the macOS version, either: 

1. right-click or Control-click `Kiyeovo.app`, choose **Open**, then confirm **Open** in the dialog.
2. Enable the app in the Privacy & Security settings tab

**Windows**

**First launch is blocked by SmartScreen.** The 1.0 build is not code-signed, so Windows Defender SmartScreen may show *"Windows protected your PC."* You only need to do this once: click **More info**, then **Run anyway**.



## Quick start from source

Most people should just grab an installer (see [Installation](#installation) above). If you want to build from source:

Requirements for running:

- Node.js 20+; Node.js < 26.x
- npm
- On Windows: a `bash` shell (Git Bash, bundled with [Git for Windows](https://git-scm.com/download/win), or WSL) — `npm run setup`/`npm run download:tor` and the other setup scripts under `scripts/` are bash scripts

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

## Servers

Kiyeovo runs a small fleet of trusted bootstrap / relay / STUN / TURN servers so
you can start without self-hosting. Add the ones nearest you in the app's Setup
pages (Bootstrap, Relay, STUN/TURN). The fast-mode bootstraps are **interconnected** —
they form one network, so you only need **2–3**; a user on any of them can find a
user on any other.

> ⚠️ **Shutdown: these servers shut down on 2026-07-26.** After that the
> app shows a one-time notice. This does **not** affect your identity, contacts, or messages — only which servers you route through.



### Fast mode

**Bootstrap servers** — Setup → Bootstrap (add 2–3 near you):

```text
/ip4/167.172.115.233/tcp/9000/p2p/12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K   # San Francisco
/ip4/137.184.147.152/tcp/9000/p2p/12D3KooWHX1n6qVE93GbGzDN7dXjVa5Qi1L2WxZAENtma8YPJtsq   # New York
/ip4/134.122.41.208/tcp/9000/p2p/12D3KooWRUpuugGb7Wqwc6vaMQWJV8piHptQYi9p91s1dgE7ebQi    # Toronto
/ip4/178.156.221.255/tcp/9000/p2p/12D3KooW9vbJN4SWN1y2GcdwPNS9kFxboQ8P3f6AtnUNeMhuvB5M   # Ashburn, US
/ip4/5.78.127.191/tcp/9000/p2p/12D3KooWChq5t2QFvkS4nDx6Uf5QmCaSycYvMggSbQF6x2pXsM1e      # Oregon, US
/ip4/178.104.248.235/tcp/9000/p2p/12D3KooWM2gccLekXRBhtQFCLYQH3ceTDpDcxBp5uNPwMScETr74   # Nuremberg, DE
/ip4/157.180.85.63/tcp/9000/p2p/12D3KooWJhPVL3tXi7zUNx95z1dTE92zsCzLLW9TS3qjrFPfcDdd     # Helsinki, FI
/ip4/157.245.149.195/tcp/9000/p2p/12D3KooWB1zQDckFKLGsDJY111prwCQpReo4pFK46C85WKQgP9sp   # Singapore
/ip4/170.64.154.208/tcp/9000/p2p/12D3KooWSoxfnJX2oMvY7y42jDLnnnCBHSku9BBhRUDnYaWqgiWp    # Sydney
```

**Relay servers** — Setup → Relay:

```text
/ip4/167.172.115.233/tcp/4002/p2p/12D3KooWDfn9gv6mQsb8CBCmXRPLbBzDaZrcZD8HiQ4a3rgNp4MM   # San Francisco
/ip4/137.184.147.152/tcp/4002/p2p/12D3KooWRbB1XRS9UFaEeconX5nQUStZGPnEhtgjkzP5RLBkYnBD   # New York
/ip4/134.122.41.208/tcp/4002/p2p/12D3KooWEhCb4tfS3G78Xg5xuYqirHkvGnDgbA8PcQk4izki5eZc    # Toronto
/ip4/178.156.221.255/tcp/4002/p2p/12D3KooWByZTmAn7uqrY6e4Lv3XW7eTHY9yxPr4KdxoUK41p1ViB   # Ashburn, US
/ip4/5.78.127.191/tcp/4002/p2p/12D3KooWF9p5aoVpC9qYj3EiytwAHgxXs41iJvo5h7gSTfmZnRzW      # Oregon, US
/ip4/178.104.248.235/tcp/4002/p2p/12D3KooWEKo9h8Rux6gRwoi9t7m1n2RnfoSAHGa2WZYw4LrTXSwH   # Nuremberg, DE
/ip4/157.180.85.63/tcp/4002/p2p/12D3KooWKdiNwZgvyMFoaLwBGhLKKgjQFUkGXMyuaNqKeFmfzmRV     # Helsinki, FI
/ip4/157.245.149.195/tcp/4002/p2p/12D3KooWK9aN5VwYnMCfeyBiXpLT28zwjK3Jp5sDkcNvuxY7ZgWE   # Singapore
/ip4/170.64.154.208/tcp/4002/p2p/12D3KooWFpR8u5L1R4FUtBDGpBq5icAo8aXta697faKQBHC1QGXE    # Sydney
```

**STUN / TURN** — Setup → STUN/TURN (only needed for audio/video calls).

STUN (no credentials) — available on every node:

```text
stun:167.172.115.233:3478   # San Francisco      stun:178.104.248.235:3478  # Nuremberg, DE
stun:137.184.147.152:3478   # New York           stun:5.78.127.191:3478     # Oregon, US
stun:134.122.41.208:3478    # Toronto            stun:157.180.85.63:3478    # Helsinki, FI
stun:170.64.154.208:3478    # Sydney             stun:157.245.149.195:3478  # Singapore
stun:178.156.221.255:3478   # Ashburn, US
```

TURN (relays call media when a direct connection can't be made) — username and
password required. Add the one(s) nearest you:


| Region        | TURN URL                    | Username  | Password                           |
| ------------- | --------------------------- | --------- | ---------------------------------- |
| San Francisco | `turn:167.172.115.233:3478` | `kiyeovo` | `tsAfclgbgNPSw6k3SmI0BVCzWezzcQLU` |
| New York      | `turn:137.184.147.152:3478` | `kiyeovo` | `rbD1luoutb0ONhsXSnNESaVaCVOxbIFd` |
| Nuremberg, DE | `turn:178.104.248.235:3478` | `kiyeovo` | `p35a3OimZ8TLQreoVBiK7OExEPgqUC8y` |
| Singapore     | `turn:157.245.149.195:3478` | `kiyeovo` | `bNagZ3o45G39KxSd3kpjNZCR16p7Q3WE` |
| Sydney        | `turn:170.64.154.208:3478`  | `kiyeovo` | `nAiNBxxe55ScPz381Vjla6eLjJIi1qqG` |




### Anonymous mode (Tor)

Onion bootstraps — Setup → Bootstrap (in anonymous mode). Unlike the fast-mode bootstraps, these are **NOT interconnected** — each is its own separate network. Two anonymous users find each other only if they share a bootstrap, so **add all of them** (or at least the same set as the person you want to reach):

```text
/onion3/26ls5ncglwcndci23ibeaz2nynivobs6armqonsnwag3gh5sn24rgmid:9000/p2p/12D3KooWApMAqAEWpWenYfXRZwWMUH8arQYjACu7xNhASBWm2st5   # San Francisco
/onion3/zsv6t577obbz45yzhvio7crbrbeyslpsa6musmkbifa6iecq55itvfyd:9000/p2p/12D3KooWPgCTLYrNyP5GkHsUjREQcUQMRxCko3hzn7NWZH8ZhxUs   # New York
/onion3/mlumqaf7yqvvewtwfjbzptubbhkforgnukpvrfmanuwt5fu5jpqcijid:9000/p2p/12D3KooWRx8PC5PFA8kkQ6fdyDyRmXibC7oVnrTEhqcb91j8VAB4   # Toronto
/onion3/syuig6dmiwkqcztfyfb4fmh5367yj6uv2yirnbculpkb3ru4ieb7dcyd:9000/p2p/12D3KooWPUsNXPWapAQUsUdiWpphk1crywH3WRECDxEGLpB8ZeFR   # Ashburn, US
/onion3/7sfi5ad4lyyr6vt353j4qlpd3cibesj6ngrqp5nie5odyl32mohngdad:9000/p2p/12D3KooWP3U59XyYP9gJc9Fzq5HS9CvyCgHBk7to8bw3cwZkBDFJ   # Oregon, US
/onion3/i6pnryrcixfivzbsz46isf3xvklnvtozdlxa66p2aicklgevh5yoz7ad:9000/p2p/12D3KooWD4q8PbvDUGTq6cJT4FtrcHKosEvH5uR54XZzKXnDZ173   # Nuremberg, DE
/onion3/zlsr3koqqpiupr54dysziv6zszhmv5tvlebdngumykmjmrkipywl6gid:9000/p2p/12D3KooWRL1uwgPRggu6g1ejGAvKCn92RTUfYBkhJSqvc3gANJem   # Helsinki, FI
/onion3/f3h7acpkqvaz7gyzvahp3jwzw4hadmrwme74k6x2udj4uddhoplas2id:9000/p2p/12D3KooWBec9kfy3Kj1Zw69WrCy8eer8hXhfyPgsqdAQPTNdWuHU   # Singapore
/onion3/flhf3mdjvs6zh3lqtrt2vd5gkag2ep6s572eg3dhgh3thisynn3le7ad:9000/p2p/12D3KooWDzpe3uinXk7eiCMH1yRD35Za8PxBeaUYMfkVa2jekq1E   # Sydney
```

Prefer not to rely on these? Self-host your own with the infrastructure bundle below.

## Bootstrap and relay setup

The recommended way to self-host is the **released** `kiyeovo-infra` **bundle**. It runs the bootstrap, relay, optional Tor onion (anonymous mode), and optional coturn TURN server as pinned Docker containers, owns their lifecycle (start/stop/restart/auto-restart) through Docker Compose, and prints the exact addresses to paste into Kiyeovo's Setup pages.

Most users should not clone this repository or build Kiyeovo from source just to self-host. The desktop app is distributed separately as installers on the [Releases page](https://github.com/Realman78/Kiyeovo/releases) (Linux `.deb`/AppImage, macOS `.dmg`), and the infrastructure bundle pulls versioned public images from GHCR.

### Recommended: release bundle (Docker)

Prerequisites: Docker Engine + the Compose plugin.

Download and unpack the `kiyeovo-infra-<version>.tar.gz` asset from the Kiyeovo
GitHub release:

```bash
VERSION=1.0.1
wget "https://github.com/Realman78/Kiyeovo/releases/download/v${VERSION}/kiyeovo-infra-${VERSION}.tar.gz"
wget "https://github.com/Realman78/Kiyeovo/releases/download/v${VERSION}/kiyeovo-infra-${VERSION}.tar.gz.sha256"
sha256sum -c "kiyeovo-infra-${VERSION}.tar.gz.sha256"

tar -xzf "kiyeovo-infra-${VERSION}.tar.gz"
cd "kiyeovo-infra-${VERSION}"

./kiyeovo-infra fast init       # Fast: bootstrap + relay; can also configure TURN
./kiyeovo-infra fast firewall   # prints the ports to open (makes no changes)
./kiyeovo-infra fast up         # pulls public GHCR images and starts Fast mode
./kiyeovo-infra fast status     # check health
./kiyeovo-infra fast addresses  # copy the printed multiaddrs into Kiyeovo
```

The bundle contains the CLI and Compose files. It does **not** contain the app
source tree, Node.js dependencies, or Docker build context. `fast up` pulls the
published image:

```text
ghcr.io/realman78/kiyeovo-infra-node:<version>
```

Connect multiple bootstraps into a single network so a user who connects to any one can find users on the others. Pass every other
bootstrap's multiaddr (from its `fast addresses` output, including the
`/p2p/<id>`) to `init`:

```bash
./kiyeovo-infra fast init --bootstrap-peers "/ip4/A.B.C.D/tcp/9000/p2p/12D3Koo...,/ip4/E.F.G.H/tcp/9000/p2p/12D3Koo..."
```

You can hand the *same* full list to every node — each skips its own entry.
Without this, each bootstrap is an isolated DHT and users on different
bootstraps can't discover each other. (Fast mode only; the anonymous onion bootstrap is inbound-only and isn't connected to others.)

To run anonymous mode too:

```bash
./kiyeovo-infra anonymous init
./kiyeovo-infra anonymous up
./kiyeovo-infra anonymous status
./kiyeovo-infra anonymous addresses
```

Anonymous mode pulls the same infra-node image plus:

```text
ghcr.io/realman78/kiyeovo-tor:<version>
```

Fast and Anonymous mode can coexist on one host. The CLI keeps their state and
Compose projects separate:

```text
instances/fast/   -> project kiyeovo-infra-fast
instances/anon/   -> project kiyeovo-infra-anon
```

If only one mode exists, the mode token may be omitted. Once both exist, name the
mode explicitly so the CLI never guesses which stack you meant. For reboot
survival: `sudo systemctl enable docker` (the containers use
`restart: unless-stopped`).

Operators who do not want Docker can use the advanced manual path below; the same
servers can also run under systemd via the templates in `infrastructure/config/`.

### Developer/source checkout testing

Use this path only if you are testing unpublished source changes or building the
infra images yourself:

```bash
git clone https://github.com/Realman78/Kiyeovo.git
cd Kiyeovo/infrastructure

./kiyeovo-infra fast init
./kiyeovo-infra fast up --build
```

`--build` is for source checkouts. Release-bundle users should normally run
`./kiyeovo-infra <mode> up` without `--build`.

### Advanced: manual setup (no Docker)

The steps below run the servers by hand and are the alternative to the CLI above.

#### Fast mode

1. Install dependencies

```bash
ROLE=bootstrap npm install
```

1. Start a bootstrap node:

```bash
BOOTSTRAP_NETWORK_MODE=fast \
BOOTSTRAP_ANNOUNCE_ADDRS=/ip4/YOUR_PUBLIC_IP/tcp/9000 \
npm run bootstrap
```

The fast bootstrap listener defaults to `0.0.0.0:9000`. If you need a different local port, set `BOOTSTRAP_LISTEN_ADDRESS`.

1. Start a relay node (if you already ran `ROLE=bootstrap npm install`):

```bash
RELAY_ANNOUNCE_ADDRS=/ip4/YOUR_PUBLIC_IP/tcp/4002 \
npm run relay
```

1. Make sure your firewall rules allow TCP on:

```text
9000  # bootstrap
4002  # relay
```

1. You should be all set now. To register the servers in Kiyeovo, open the **Setup** tab in the left sidebar rail, then add each multiaddress with **Add server** — the bootstrap address under **Bootstrap servers** and the relay address under **Relay servers**:

```text
/ip4/YOUR_PUBLIC_IP/tcp/9000/p2p/<BOOTSTRAP_PEER_ID>
/ip4/YOUR_PUBLIC_IP/tcp/4002/p2p/<RELAY_PEER_ID>
```



#### Anonymous mode

1. Run the setup script

```bash
ROLE=bootstrap npm run setup
```

1. Install and start a Tor daemon on the host. Example on linux:

```
apt update
apt install tor
systemctl start tor
systemctl enable tor # if you want to enable it on startup
systemctl status tor # verify it's running
```

1. Configure a hidden service that forwards the public onion port to the local bootstrap listener. Example on linux - add the below config to `/etc/tor/torrc`:

```conf
HiddenServiceDir /var/lib/tor/kiyeovo-bootstrap/ # you will find your onion hostname here later
HiddenServicePort 9000 127.0.0.1:9001
```

After changes, restart the tor service: `systemctl restart tor`

Find your onion host: `cat /var/lib/tor/kiyeovo-bootstrap/hostname`

1. Start a bootstrap node in anonymous mode:

```bash
BOOTSTRAP_NETWORK_MODE=anonymous \
BOOTSTRAP_LISTEN_ADDRESS=/ip4/127.0.0.1/tcp/9001 \
BOOTSTRAP_ANNOUNCE_ADDRS=/onion3/YOUR_ONION_HOST:9000 \
npm run bootstrap
```

If you host both fast and anonymous bootstrap nodes on the same machine, keep fast mode on `0.0.0.0:9000` and anonymous mode on local `127.0.0.1:9001`.

1. The setup is done. To register the server in Kiyeovo, open the **Setup** tab in the left sidebar rail, go to **Bootstrap servers**, and add the address with **Add server**:

```text
/onion3/YOUR_ONION_HOST:9000/p2p/<BOOTSTRAP_PEER_ID>
```

The relay is not needed in anonymous mode.

#### (Optional) STUN/TURN for calls in Fast mode

Calls are fast-mode only (both 1:1 and group).

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

1. Set up firewall (if firewall is enabled)
  - ALLOW TCP and UDP on port 3478
    - ALLOW UDP on port range 49160:49200.
    - From before: if you are running bootstrap and relay, ALLOW TCP on ports 9000 (bootstrap) and 4002 (relay)
2. Run `systemctl enable --now coturn`
3. The servers should be running now. To register them in Kiyeovo, open the **Setup** tab in the left sidebar rail and go to **STUN/TURN servers**, then add each entry with **Add server**.

You can add multiple ICE servers. Kiyeovo supports `stun`, `turn`, and `turns` entries.

## Technical note

The desktop app is built with Electron, React, and libp2p.

## How this differs from similar solutions (roughly)

> This comparison is a rough, best-effort snapshot and may drift as all these projects evolve.

- Briar: Briar runs everything over Tor and also supports syncing via Bluetooth, Wi-Fi or memory cards. Kiyeovo instead has two separate, and completely isolated, network modes -> Fast (clearnet) and Anonymous (Tor) - you can choose between performance (and additional features) and anonymity
- Session: Session uses its own network of nodes to send and store messages. Kiyeovo uses pure libp2p and stores offline messages in the DHT - simpler, but not guaranteed "always-on".
- Tox: Tox runs as one global P2P network. Kiyeovo splits things into two separate networks depending on the mode.
- Ricochet: Ricochet is simple Tor-based messaging. Kiyeovo also has Tor-based messaging, but also has a ton more features and capabilites.

