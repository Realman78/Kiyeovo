#!/usr/bin/env bash
# Build the Kiyeovo infrastructure release: the amd64 infra-node + Tor images and the
# operator bundle (CLI + compose files + .env example + systemd templates +
# checksums). It does NOT push images or create the GitHub release — those need
# credentials, so it prints the exact commands to run instead.
#
# Usage:
#   infrastructure/scripts/build-release.sh [VERSION] [--bundle-only] [--no-build]
#
#   VERSION        image tag + bundle version (default: 0.1.0)
#   --bundle-only  skip image builds; just assemble the bundle + checksums
#   --no-build     alias for --bundle-only
#
# Env overrides:
#   INFRA_NODE_IMAGE  default ghcr.io/realman78/kiyeovo-infra-node
#   TOR_IMAGE         default ghcr.io/realman78/kiyeovo-tor
set -euo pipefail

VERSION="0.1.0"
BUILD_IMAGES=1
for arg in "$@"; do
  case "$arg" in
    --bundle-only|--no-build) BUILD_IMAGES=0 ;;
    -*) echo "build-release: unknown option '$arg'" >&2; exit 2 ;;
    *) VERSION="$arg" ;;
  esac
done

case "$VERSION" in
  ''|.*|-*|_*|*[!A-Za-z0-9._-]*)
    echo "build-release: invalid VERSION '$VERSION' (use letters, numbers, dot, underscore, or dash; start with a letter/number)" >&2
    exit 2
    ;;
esac

INFRA_NODE_IMAGE="${INFRA_NODE_IMAGE:-ghcr.io/realman78/kiyeovo-infra-node}"
TOR_IMAGE="${TOR_IMAGE:-ghcr.io/realman78/kiyeovo-tor}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
OUT_DIR="$REPO_ROOT/dist-release"
BUNDLE_NAME="kiyeovo-infra-$VERSION"
BUNDLE_DIR="$OUT_DIR/$BUNDLE_NAME"

log() { printf '\033[1m==> %s\033[0m\n' "$*"; }

# ---- 1. Gate on the server dependency manifest being in sync. ----
log "Checking server dependency manifest is in sync with imports"
node "$SCRIPT_DIR/check-server-deps.mjs"

# ---- 2. Build the amd64 images (pinned by version, never :latest). ----
if [ "$BUILD_IMAGES" -eq 1 ]; then
  log "Building $INFRA_NODE_IMAGE:$VERSION (linux/amd64)"
  docker build --platform linux/amd64 -f "$INFRA_DIR/Dockerfile.server" \
    -t "$INFRA_NODE_IMAGE:$VERSION" "$REPO_ROOT"
  log "Building $TOR_IMAGE:$VERSION (linux/amd64)"
  docker build --platform linux/amd64 -f "$INFRA_DIR/Dockerfile.tor" \
    -t "$TOR_IMAGE:$VERSION" "$REPO_ROOT"
else
  log "Skipping image builds (--bundle-only)"
fi

# Emit a runtime-only compose file for the bundle: pin images to the requested
# $VERSION (and any INFRA_NODE_IMAGE/TOR_IMAGE override), bump
# KIYEOVO_SERVER_VERSION to match, and strip the `build:` blocks so the bundle
# never assumes a source tree (operators pull the published images; they don't
# build).
bundle_compose() {
  local src="$1" dst="$2"
  sed -E \
    -e '/^[[:space:]]+build:[[:space:]]*$/,/^[[:space:]]+dockerfile:[[:space:]]/d' \
    -e "s#(image:[[:space:]]+)[^[:space:]]*kiyeovo-infra-node:[^[:space:]]*#\\1$INFRA_NODE_IMAGE:$VERSION#" \
    -e "s#(image:[[:space:]]+)[^[:space:]]*kiyeovo-tor:[^[:space:]]*#\\1$TOR_IMAGE:$VERSION#" \
    -e "s#(KIYEOVO_SERVER_VERSION:[[:space:]]+)\"[^\"]*\"#\\1\"$VERSION\"#" \
    "$src" > "$dst"
}

# ---- 3. Assemble the operator bundle. ----
log "Assembling bundle $BUNDLE_NAME"
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/config"
cp "$INFRA_DIR/kiyeovo-infra"            "$BUNDLE_DIR/"
bundle_compose "$INFRA_DIR/compose.yaml"           "$BUNDLE_DIR/compose.yaml"
bundle_compose "$INFRA_DIR/compose.anonymous.yaml" "$BUNDLE_DIR/compose.anonymous.yaml"
cp "$INFRA_DIR/.env.example"           "$BUNDLE_DIR/"
cp "$INFRA_DIR/config/kiyeovo-bootstrap.service.template" "$BUNDLE_DIR/config/"
cp "$INFRA_DIR/config/kiyeovo-relay.service.template"     "$BUNDLE_DIR/config/"
chmod +x "$BUNDLE_DIR/kiyeovo-infra"

# Record exactly which images this bundle expects.
cat >"$BUNDLE_DIR/IMAGES.txt" <<EOF
$INFRA_NODE_IMAGE:$VERSION
$TOR_IMAGE:$VERSION
EOF

# ---- 4. Checksums over the bundle contents. ----
log "Writing SHA256SUMS"
( cd "$BUNDLE_DIR" && find . -type f ! -name SHA256SUMS -print0 \
    | sort -z | xargs -0 sha256sum > SHA256SUMS )

# ---- 5. Tarball. ----
log "Creating tarball"
( cd "$OUT_DIR" && tar -czf "$BUNDLE_NAME.tar.gz" "$BUNDLE_NAME" )
TARBALL="$OUT_DIR/$BUNDLE_NAME.tar.gz"
( cd "$OUT_DIR" && sha256sum "$BUNDLE_NAME.tar.gz" > "$BUNDLE_NAME.tar.gz.sha256" )

log "Done."
echo "  bundle dir: $BUNDLE_DIR"
echo "  tarball:    $TARBALL"
echo ""
echo "Next (require your credentials — not run automatically):"
echo "  # 1. log in to GHCR, then push the pinned images:"
echo "  docker push $INFRA_NODE_IMAGE:$VERSION"
echo "  docker push $TOR_IMAGE:$VERSION"
echo "  # 2. publish the bundle as a GitHub release asset:"
echo "  gh release create v$VERSION \"$TARBALL\" \"$TARBALL.sha256\" \\"
echo "      --title \"kiyeovo-infra $VERSION\" --notes \"Self-hosted bootstrap/relay/TURN bundle\""
