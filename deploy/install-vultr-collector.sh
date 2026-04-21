#!/usr/bin/env bash
# ============================================================================
# NOC Collector VPS — GitHub bootstrap installer
# ============================================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/patrikalmeida7/ntflow/main/deploy/install-vultr-collector.sh | sudo bash
#
# Always pulls the full collector setup from the main branch before running.
# Override defaults if needed:
#   REPO_OWNER=patrikalmeida7 REPO_NAME=ntflow BRANCH=main sudo -E bash install-vultr-collector.sh
# ============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
log() { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $*"; }
ok() { echo -e "${GREEN}✓${NC} $*"; }
err() { echo -e "${RED}✗${NC} $*" >&2; }

[ "$(id -u)" -eq 0 ] || { err "Run as root: curl ... | sudo bash"; exit 1; }

REPO_OWNER="${REPO_OWNER:-patrikalmeida7}"
REPO_NAME="${REPO_NAME:-ntflow}"
BRANCH="${BRANCH:-main}"
SETUP_PATH="deploy/vultr-collector-setup.sh"
RAW_BASE="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}"
SETUP_URL="${RAW_BASE}/${SETUP_PATH}"
TMP_SETUP="$(mktemp /tmp/noc-vultr-setup.XXXXXX.sh)"

cleanup() {
  rm -f "$TMP_SETUP"
}
trap cleanup EXIT

log "Downloading collector setup from GitHub main branch..."
echo "  URL: $SETUP_URL"

if ! curl -fsSL "$SETUP_URL" -o "$TMP_SETUP"; then
  err "Could not download setup script from GitHub."
  err "Check if the repository is public and the file exists at: $SETUP_PATH"
  exit 1
fi

if ! head -1 "$TMP_SETUP" | grep -qx '#!/usr/bin/env bash'; then
  err "Downloaded file is not the expected bash setup script."
  err "First line was: $(head -1 "$TMP_SETUP" || true)"
  exit 1
fi

chmod +x "$TMP_SETUP"
ok "Setup script downloaded and validated"
log "Running Vultr collector setup..."
exec bash "$TMP_SETUP"
