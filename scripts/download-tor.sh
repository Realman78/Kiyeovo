#!/bin/bash

# Download Tor Expert Bundle for Kiyeovo
# This script downloads the Tor binary for the current platform
# and places it in the resources/tor directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/resources/tor"

# Tor Expert Bundle version (check https://www.torproject.org/download/tor/ for latest)
TOR_VERSION="14.0.4"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

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
                *)
                    echo -e "${RED}Unsupported Linux architecture: $arch${NC}"
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

            # Also copy required libraries for macOS and sign copied artifacts.
            if [[ "$platform" == darwin-* ]]; then
                local tor_dir=$(dirname "$tor_binary")
                # Copy any dylib files
                find "$tor_dir" -name "*.dylib" -exec cp {} "$target_dir/" \; 2>/dev/null || true
                if ls "$target_dir"/*.dylib 1> /dev/null 2>&1; then
                    echo -e "${GREEN}Copied required libraries${NC}"
                fi

                if command -v xattr &> /dev/null; then
                    xattr -dr com.apple.quarantine "$target_dir" 2>/dev/null || true
                fi

                if command -v codesign &> /dev/null; then
                    if ls "$target_dir"/*.dylib 1> /dev/null 2>&1; then
                        while IFS= read -r dylib; do
                            codesign --force --sign - --timestamp=none "$dylib"
                        done < <(find "$target_dir" -maxdepth 1 -name "*.dylib" -type f)
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
