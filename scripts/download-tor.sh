#!/bin/bash

# Download Tor Expert Bundle for Kiyeovo
# This script downloads the Tor binary for the current platform
# and places it in the resources/tor directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/resources/tor"

# Tor Expert Bundle version (check https://www.torproject.org/download/tor/ for latest)
TOR_VERSION="15.0.18"

# Pinned SHA-256 checksums for each platform's Tor Expert Bundle archive at
# TOR_VERSION above. Verified by downloading each of the four archives from
# dist.torproject.org and hashing them directly, and cross-checked against
# dist.torproject.org's own signed manifest
# (torbrowser/${TOR_VERSION}/sha256sums-signed-build.txt).
#
# Pinned from dist.torproject.org on 2026-07-20 for TOR_VERSION=15.0.18.
# These MUST be re-pinned (all four hashes) every time TOR_VERSION is
# bumped - a stale pin will hard-fail the download below rather than
# silently accepting a mismatched archive.
#
# TODO: these hash pins only protect against a corrupted/tampered
# download after the hashes were pinned; it doesn't protect against a
# compromise at pinning time the way verifying the upstream PGP (.asc)
# signature would. Switch to .asc signature verification (against the
# Tor Browser developers' signing keys) when there's time to wire up gpg
# in CI; that's the better long-term answer.
# Keep this as a case statement rather than a Bash associative array: macOS
# runners and stock macOS installations still ship Bash 3.2, while `declare -A`
# requires Bash 4 and would break every macOS Tor/release build.
expected_sha256_for() {
    case "$1" in
        linux-x64)
            echo "5a8f19f5f119b5fa2a8fd799a3a532e3236ad36164241800d6302e32f0e1c2a9"
            ;;
        darwin-x64)
            echo "95243f76bcf05d6179d017c3f3e4ece7b53cc58dff1ba617b03a2fe2c8298b5b"
            ;;
        darwin-arm64)
            echo "c99cf6f69740a443c7fffaf598ceb0952b3914041507c8afe11bed84a3333eb1"
            ;;
        win32-x64)
            echo "6ac067402c7b4a3dc37887ed3754b3914b67fdc220c966190683e9ccf91abf0f"
            ;;
        *)
            return 1
            ;;
    esac
}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Compute a file's SHA-256 digest using whichever tool is available.
compute_sha256() {
    local file="$1"
    if command -v sha256sum &> /dev/null; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum &> /dev/null; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        echo -e "${RED}Neither sha256sum nor shasum found; cannot verify archive integrity.${NC}"
        exit 1
    fi
}

echo -e "${GREEN}Kiyeovo - Tor Binary Downloader${NC}"
echo "=========================================="
echo ""

# Detect platform
detect_platform() {
    local os=$(uname -s)
    local arch=$(uname -m)

    case "$os" in
        Linux)
            case "$arch" in
                x86_64)
                    echo "linux-x64"
                    ;;
                aarch64|arm64)
                    # Upstream builds the Tor Expert Bundle for linux-x86_64 and
                    # linux-i686 only - aarch64 exists for macOS and Android, but
                    # not for Linux. There is nothing to download here, so arm64
                    # Linux builds ship without Tor and run fast mode only. The
                    # app mirrors this in getBundledTorPlatformDir().
                    echo -e "${RED}No Tor Expert Bundle is published for linux-aarch64.${NC}" >&2
                    echo -e "${YELLOW}arm64 Linux builds ship without bundled Tor; anonymous mode is unavailable there.${NC}" >&2
                    exit 1
                    ;;
                *)
                    echo -e "${RED}Unsupported Linux architecture: $arch${NC}" >&2
                    exit 1
                    ;;
            esac
            ;;
        Darwin)
            case "$arch" in
                x86_64)
                    echo "darwin-x64"
                    ;;
                arm64)
                    echo "darwin-arm64"
                    ;;
                *)
                    echo -e "${RED}Unsupported macOS architecture: $arch${NC}"
                    exit 1
                    ;;
            esac
            ;;
        CYGWIN*|MINGW*|MSYS*)
            case "$arch" in
                x86_64)
                    echo "win32-x64"
                    ;;
                *)
                    echo -e "${RED}Unsupported Windows architecture: $arch${NC}"
                    exit 1
                    ;;
            esac
            ;;
        *)
            echo -e "${RED}Unsupported operating system: $os${NC}"
            exit 1
            ;;
    esac
}

# Download and extract Tor for a specific platform
download_tor() {
    local platform=$1
    local target_dir="$RESOURCES_DIR/$platform"

    mkdir -p "$target_dir"

    local download_url=""
    local archive_name=""

    case "$platform" in
        linux-x64)
            archive_name="tor-expert-bundle-linux-x86_64-${TOR_VERSION}.tar.gz"
            download_url="https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/${archive_name}"
            ;;
        darwin-x64)
            archive_name="tor-expert-bundle-macos-x86_64-${TOR_VERSION}.tar.gz"
            download_url="https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/${archive_name}"
            ;;
        darwin-arm64)
            archive_name="tor-expert-bundle-macos-aarch64-${TOR_VERSION}.tar.gz"
            download_url="https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/${archive_name}"
            ;;
        win32-x64)
            archive_name="tor-expert-bundle-windows-x86_64-${TOR_VERSION}.tar.gz"
            download_url="https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/${archive_name}"
            ;;
        *)
            echo -e "${RED}Unknown platform: $platform${NC}"
            return 1
            ;;
    esac

    echo -e "${YELLOW}Downloading Tor for $platform...${NC}"
    echo "URL: $download_url"

    local temp_dir=$(mktemp -d)
    local archive_path="$temp_dir/$archive_name"

    # Download
    if command -v curl &> /dev/null; then
        curl -L -o "$archive_path" "$download_url"
    elif command -v wget &> /dev/null; then
        wget -O "$archive_path" "$download_url"
    else
        echo -e "${RED}Neither curl nor wget found. Please install one of them.${NC}"
        exit 1
    fi

    # Verify the download against the pinned checksum before doing anything
    # else with it. This is a hard failure: an unexpected hash could mean a
    # tampered/corrupted download, or a stale pin left over from a version
    # bump - either way we must not extract or install the archive.
    local expected_sha256=""
    expected_sha256=$(expected_sha256_for "$platform" || true)
    if [[ -z "$expected_sha256" ]]; then
        echo -e "${RED}No pinned SHA-256 checksum for platform '$platform' at TOR_VERSION=${TOR_VERSION}.${NC}"
        echo -e "${RED}Refusing to install an unverified Tor archive. Pin it in expected_sha256_for first.${NC}"
        rm -rf "$temp_dir"
        exit 1
    fi

    echo -e "${YELLOW}Verifying SHA-256 checksum...${NC}"
    local actual_sha256
    actual_sha256=$(compute_sha256 "$archive_path")
    if [[ "$actual_sha256" != "$expected_sha256" ]]; then
        echo -e "${RED}SHA-256 checksum mismatch for $archive_name!${NC}"
        echo -e "${RED}  expected: $expected_sha256${NC}"
        echo -e "${RED}  actual:   $actual_sha256${NC}"
        echo -e "${RED}Refusing to install this archive - it does not match the pinned checksum.${NC}"
        echo -e "${RED}This could mean a corrupted/tampered download, or that TOR_VERSION was bumped without re-pinning expected_sha256_for.${NC}"
        rm -rf "$temp_dir"
        exit 1
    fi
    echo -e "${GREEN}Checksum verified.${NC}"

    # Extract
    echo -e "${YELLOW}Extracting...${NC}"
    tar -xzf "$archive_path" -C "$temp_dir"

    # Find and copy the tor binary
    # Note: -executable doesn't work on macOS, so we look for the binary by path pattern
    local tor_binary=""

    echo -e "${YELLOW}Searching for tor binary...${NC}"

    if [[ "$platform" == "win32-x64" ]]; then
        tor_binary=$(find "$temp_dir" -name "tor.exe" -type f | head -1)
        if [[ -n "$tor_binary" ]]; then
            cp "$tor_binary" "$target_dir/tor.exe"
            echo -e "${GREEN}Copied tor.exe to $target_dir${NC}"

            # Copy any DLLs the bundle ships beside the .exe. Windows resolves
            # DLLs next to the executable natively, so no lib-path env is needed
            # at runtime, but the DLLs themselves must be present.
            local win_tor_dir=$(dirname "$tor_binary")
            find "$win_tor_dir" -maxdepth 1 -name "*.dll" -exec cp {} "$target_dir/" \; 2>/dev/null || true
            if ls "$target_dir"/*.dll 1> /dev/null 2>&1; then
                echo -e "${GREEN}Copied bundled runtime DLLs${NC}"
            fi
        fi
    else
        # Try common locations in Tor Expert Bundle
        # Structure is usually: tor-expert-bundle_*/tor/tor
        tor_binary=$(find "$temp_dir" -path "*/tor/tor" -type f | head -1)

        # Fallback: find any file named "tor" that's not a directory
        if [[ -z "$tor_binary" ]]; then
            tor_binary=$(find "$temp_dir" -name "tor" -type f ! -name "*.txt" ! -name "*.md" | head -1)
        fi

        if [[ -n "$tor_binary" ]]; then
            cp "$tor_binary" "$target_dir/tor"
            chmod +x "$target_dir/tor"
            echo -e "${GREEN}Copied tor to $target_dir${NC}"

            local tor_dir=$(dirname "$tor_binary")

            # Copy the runtime libraries the bundle ships BESIDE the binary. The
            # bundled tor has no RUNPATH/RPATH and NEEDs these co-located libs
            # (e.g. libevent-2.1.so.7 on Linux) which are absent from system
            # paths on many machines. tor-manager.ts points LD_LIBRARY_PATH /
            # DYLD_LIBRARY_PATH at this dir at spawn time so they're resolved.
            # maxdepth 1 keeps this to direct siblings (skips pluggable_transports).
            if [[ "$platform" == linux-* ]]; then
                # Copy every shared object shipped next to the binary (*.so, *.so.N...).
                find "$tor_dir" -maxdepth 1 -name "*.so*" -exec cp -P {} "$target_dir/" \; 2>/dev/null || true
                if ls "$target_dir"/*.so* 1> /dev/null 2>&1; then
                    echo -e "${GREEN}Copied bundled runtime libraries${NC}"
                fi
            fi

            # Also copy required libraries for macOS and sign copied artifacts.
            if [[ "$platform" == darwin-* ]]; then
                # Copy any dylib files (including versioned *.dylib.N siblings).
                find "$tor_dir" -maxdepth 1 -name "*.dylib*" -exec cp -P {} "$target_dir/" \; 2>/dev/null || true
                if ls "$target_dir"/*.dylib* 1> /dev/null 2>&1; then
                    echo -e "${GREEN}Copied required libraries${NC}"
                fi

                if command -v xattr &> /dev/null; then
                    xattr -dr com.apple.quarantine "$target_dir" 2>/dev/null || true
                fi

                if command -v codesign &> /dev/null; then
                    if ls "$target_dir"/*.dylib* 1> /dev/null 2>&1; then
                        while IFS= read -r dylib; do
                            codesign --force --sign - --timestamp=none "$dylib"
                        done < <(find "$target_dir" -maxdepth 1 -name "*.dylib*" -type f)
                    fi
                    codesign --force --sign - --timestamp=none "$target_dir/tor"
                    codesign --verify --verbose=1 "$target_dir/tor" >/dev/null 2>&1 || true
                    echo -e "${GREEN}Applied ad-hoc signature to Tor binary and bundled libraries${NC}"
                else
                    echo -e "${YELLOW}codesign not found; skipping ad-hoc signing${NC}"
                fi
            fi
        fi
    fi

    if [[ -z "$tor_binary" ]]; then
        echo -e "${RED}Could not find tor binary in archive${NC}"
        echo "Contents of archive:"
        find "$temp_dir" -type f
        rm -rf "$temp_dir"
        return 1
    fi

    # Cleanup
    rm -rf "$temp_dir"

    echo -e "${GREEN}Successfully installed Tor for $platform${NC}"
}

# Main
main() {
    local target_platform="${1:-}"

    if [[ -z "$target_platform" ]]; then
        # Auto-detect current platform
        target_platform=$(detect_platform)
        echo "Detected platform: $target_platform"
    fi

    if [[ "$target_platform" == "all" ]]; then
        echo -e "${YELLOW}Downloading Tor for all platforms...${NC}"
        for p in linux-x64 darwin-x64 darwin-arm64 win32-x64; do
            echo ""
            download_tor "$p" || echo -e "${YELLOW}Warning: Failed to download for $p${NC}"
        done
    else
        download_tor "$target_platform"
    fi

    echo ""
    echo -e "${GREEN}Done!${NC}"
    echo ""
    echo "Tor binaries are located in: $RESOURCES_DIR"
    ls -la "$RESOURCES_DIR"/*/ 2>/dev/null || true
}

main "$@"
