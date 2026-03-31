# Bundled Tor Binaries

This directory contains the Tor daemon binaries bundled with Kiyeovo Desktop.

## Directory Structure

```
tor/
├── linux-x64/tor         # Linux x86_64
├── darwin-x64/tor        # macOS Intel
├── darwin-arm64/tor      # macOS Apple Silicon
└── win32-x64/tor.exe     # Windows x64
```

## Downloading Binaries

Run one of the following commands from the project root:

```bash
# Download for current platform only
npm run download:tor

# Download for all platforms (for distribution builds)
npm run download:tor:all
```

Or run the script directly:

```bash
./scripts/download-tor.sh           # Current platform
./scripts/download-tor.sh linux-x64 # Specific platform
./scripts/download-tor.sh all       # All platforms
```

## Version

The Tor version is defined in `scripts/download-tor.sh`. Update the `TOR_VERSION` variable to use a different version.

Current version: **14.0.4**

## Notes

- Binaries are downloaded from the official Tor Project archive
- The binaries are NOT committed to git (see `.gitignore`)
- For production builds, ensure you download the Tor binary for the target platform before running `electron-builder`

## Ports Used

Kiyeovo uses non-standard ports to avoid conflicts with system Tor or Tor Browser:

| Component | Port |
|-----------|------|
| SOCKS Proxy | 9550 |
| Control Port | 9551 |

This avoids conflicts with:
- System Tor (9050/9051)
- Tor Browser (9150/9151)
