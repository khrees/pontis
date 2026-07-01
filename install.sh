#!/usr/bin/env bash

# =============================================
#  Pontis Installer 🌌
#  Quick installation script for Pontis CLI
# =============================================

set -e

REPO="khrees/pontis"

# Parse arguments
INSTALL_CLIENTS=""
SKIP_CLIENTS=""
MINIMAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --with-clients|--with-all)
      INSTALL_CLIENTS="all"
      shift
      ;;
    --with-claude)
      INSTALL_CLIENTS="${INSTALL_CLIENTS} claude"
      shift
      ;;
    --with-codex)
      INSTALL_CLIENTS="${INSTALL_CLIENTS} codex"
      shift
      ;;
    --with-opencode)
      INSTALL_CLIENTS="${INSTALL_CLIENTS} opencode"
      shift
      ;;
    --with-pi)
      INSTALL_CLIENTS="${INSTALL_CLIENTS} pi"
      shift
      ;;
    --without-claude)
      SKIP_CLIENTS="${SKIP_CLIENTS} claude"
      shift
      ;;
    --without-codex)
      SKIP_CLIENTS="${SKIP_CLIENTS} codex"
      shift
      ;;
    --without-opencode)
      SKIP_CLIENTS="${SKIP_CLIENTS} opencode"
      shift
      ;;
    --without-pi)
      SKIP_CLIENTS="${SKIP_CLIENTS} pi"
      shift
      ;;
    --minimal)
      MINIMAL="1"
      shift
      ;;
    --help|-h)
      echo "Pontis Installer 🌌"
      echo ""
      echo "Usage: curl -fsSL https://pontis.dev/install.sh | bash [-- <flags>]"
      echo ""
      echo "Flags:"
      echo "  --with-clients     Install all client tools (Claude Code, Codex, OpenCode, Pi)"
      echo "  --with-claude      Install Claude Code"
      echo "  --with-codex       Install Codex CLI"
      echo "  --with-opencode    Install OpenCode CLI"
      echo "  --with-pi          Install Pi coding agent"
      echo "  --without-<name>   Skip specific client"
      echo "  --minimal          Install Pontis only (no client tools)"
      echo "  --help             Show this help"
      echo ""
      echo "Environment:"
      echo "  PONTIS_VERSION     Install a specific version (default: latest)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage"
      exit 1
      ;;
  esac
done

# Prefer ~/.local/bin if it's in PATH, otherwise fall back to /usr/local/bin
if echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin"; then
  INSTALL_DIR="$HOME/.local/bin"
else
  INSTALL_DIR="/usr/local/bin"
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "  → $1"; }
success() { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
error() { echo -e "${RED}error:${NC} $1"; exit 1; }

echo -e "  ${GREEN}Pontis CLI Installer 🌌${NC}"
echo ""

# Detect OS
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
  darwin) OS="darwin" ;;
  linux) OS="linux" ;;
  *) error "Unsupported operating system: $OS" ;;
esac

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) error "Unsupported architecture: $ARCH" ;;
esac

# macOS Intel fallback warning
ARCH_WARN=""
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
  ARCH_WARN=" (Intel)"
fi

# Determine asset name for proxy binary
if [ "$OS" = "darwin" ]; then
  if [ "$ARCH" = "arm64" ]; then
    ASSET_NAME="pontis-proxy-macos-arm64"
  else
    ASSET_NAME="pontis-proxy-macos-x64"
  fi
elif [ "$OS" = "linux" ]; then
  ASSET_NAME="pontis-proxy-linux-x64"
fi

info "$OS-$ARCH$ARCH_WARN"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
  warn "Node.js is not found. Note that harnesses like Claude Code require Node.js (v18+) to run."
fi

# Create install dir
mkdir -p "$INSTALL_DIR"

# Get release tag name (allow override via PONTIS_VERSION env var)
if [ -n "$PONTIS_VERSION" ]; then
  TAG_NAME="$PONTIS_VERSION"
  info "Using specified version: $TAG_NAME"
else
  RELEASE_INFO=$(curl -s https://api.github.com/repos/$REPO/releases/latest || echo "")
  TAG_NAME=$(echo "$RELEASE_INFO" | grep -o '"tag_name": "[^"]*' | grep -o '[^"]*$' || echo "")
  if [ -z "$TAG_NAME" ]; then
    error "Failed to retrieve latest release version from GitHub API. Please check your internet connection."
  fi
  info "Version $TAG_NAME"
fi

# Download assets
LAUNCHER_URL="https://github.com/$REPO/releases/download/$TAG_NAME/pontis"
CLI_URL="https://github.com/$REPO/releases/download/$TAG_NAME/cli.mjs"
BINARY_URL="https://github.com/$REPO/releases/download/$TAG_NAME/$ASSET_NAME"

info "Downloading assets..."
TMP_LAUNCHER=$(mktemp)
TMP_CLI=$(mktemp)
TMP_BINARY=$(mktemp)

# Launcher + CLI are small — fire them off silently in parallel
curl -sSfL "$LAUNCHER_URL" -o "$TMP_LAUNCHER" &
PID1=$!
curl -sSfL "$CLI_URL" -o "$TMP_CLI" &
PID2=$!
OK=1
wait $PID1 || OK=0
wait $PID2 || OK=0
[ "$OK" = 1 ] || error "Failed to download launcher or CLI bundle"

chmod +x "$TMP_LAUNCHER"

# Proxy is the bigger one — show progress
curl -fL --progress-bar "$BINARY_URL" -o "$TMP_BINARY" || error "Failed to download binary from $BINARY_URL"
chmod +x "$TMP_BINARY"

# Verify integrity via SHA256 checksums
CHECKSUM_URL="https://github.com/$REPO/releases/download/$TAG_NAME/checksums.sha256"
TMP_CHECKSUMS=$(mktemp)
if curl -fsSL "$CHECKSUM_URL" -o "$TMP_CHECKSUMS" 2>/dev/null; then
  LAUNCHER_HASH=$(shasum -a 256 "$TMP_LAUNCHER" | awk '{print $1}')
  CLI_HASH=$(shasum -a 256 "$TMP_CLI" | awk '{print $1}')
  BINARY_HASH=$(shasum -a 256 "$TMP_BINARY" | awk '{print $1}')
  LAUNCHER_EXPECTED=$(grep "pontis$" "$TMP_CHECKSUMS" | head -1 | awk '{print $1}')
  CLI_EXPECTED=$(grep "cli\.mjs" "$TMP_CHECKSUMS" | head -1 | awk '{print $1}')
  BINARY_EXPECTED=$(grep "$ASSET_NAME" "$TMP_CHECKSUMS" | head -1 | awk '{print $1}')
  if [ -n "$LAUNCHER_EXPECTED" ] && [ "$LAUNCHER_HASH" != "$LAUNCHER_EXPECTED" ]; then
    rm -f "$TMP_LAUNCHER" "$TMP_CLI" "$TMP_BINARY" "$TMP_CHECKSUMS"
    error "Launcher checksum mismatch! Expected $LAUNCHER_EXPECTED, got $LAUNCHER_HASH. Aborting."
  fi
  if [ -n "$CLI_EXPECTED" ] && [ "$CLI_HASH" != "$CLI_EXPECTED" ]; then
    rm -f "$TMP_LAUNCHER" "$TMP_CLI" "$TMP_BINARY" "$TMP_CHECKSUMS"
    error "CLI bundle checksum mismatch! Expected $CLI_EXPECTED, got $CLI_HASH. Aborting."
  fi
  if [ -n "$BINARY_EXPECTED" ] && [ "$BINARY_HASH" != "$BINARY_EXPECTED" ]; then
    rm -f "$TMP_LAUNCHER" "$TMP_CLI" "$TMP_BINARY" "$TMP_CHECKSUMS"
    error "Binary checksum mismatch! Expected $BINARY_EXPECTED, got $BINARY_HASH. Aborting."
  fi
  rm -f "$TMP_CHECKSUMS"
  VERIFIED=1
else
  warn "Checksums not available for this release — skipping verification"
  VERIFIED=""
  rm -f "$TMP_CHECKSUMS"
fi

# Code-sign the binary on macOS to prevent Gatekeeper from killing it (exit code 137)
SIGNED=""
if [ "$OS" = "darwin" ]; then
  if command -v codesign &>/dev/null; then
    codesign -s - --force "$TMP_BINARY" 2>/dev/null && SIGNED="signed" || true
  fi
fi

# Remove previous Pontis install artifacts (handles renames across versions)
PONTIS_OLD_FILES="pontis pontis-proxy cli.js cli.mjs"
for f in $PONTIS_OLD_FILES; do
  if [ -f "$INSTALL_DIR/$f" ]; then
    if [ -w "$INSTALL_DIR/$f" ]; then
      rm -f "$INSTALL_DIR/$f"
    else
      sudo rm -f "$INSTALL_DIR/$f"
    fi
  fi
done

# Install launcher, CLI bundle, and proxy binary to destination
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP_LAUNCHER" "$INSTALL_DIR/pontis"
  mv "$TMP_CLI" "$INSTALL_DIR/cli.mjs"
  mv "$TMP_BINARY" "$INSTALL_DIR/pontis-proxy"
  INSTALLED="installed"
else
  INSTALLED="installed (via sudo)"
  sudo mv "$TMP_LAUNCHER" "$INSTALL_DIR/pontis"
  sudo mv "$TMP_CLI" "$INSTALL_DIR/cli.mjs"
  sudo mv "$TMP_BINARY" "$INSTALL_DIR/pontis-proxy"
fi

# Verify Pontis installation
PONTIS_OK=0
if command -v pontis &> /dev/null; then
  PONTIS_OK=1
  if [ -n "$VERIFIED" ] || [ -n "$SIGNED" ]; then
    success "Downloaded${VERIFIED:+, verified}${SIGNED:+, $SIGNED}, and $INSTALLED to $INSTALL_DIR"
  else
    success "Downloaded and $INSTALLED to $INSTALL_DIR"
  fi
else
  warn "Installed but 'pontis' not found in PATH. You may need to add $INSTALL_DIR to your PATH."
fi

echo ""

# ──────────────────────────────────────────────
#  Client tools installation
# ──────────────────────────────────────────────

# Determine which clients to install
CLIENTS_TO_INSTALL=""

if [ -n "$MINIMAL" ]; then
  # --minimal: skip all clients
  :
elif [ -n "$INSTALL_CLIENTS" ]; then
  # --with-* flags explicitly specified
  if [ "$INSTALL_CLIENTS" = "all" ]; then
    CLIENTS_TO_INSTALL="claude codex opencode pi"
  else
    CLIENTS_TO_INSTALL="$INSTALL_CLIENTS"
  fi
elif [ -z "$SKIP_CLIENTS" ] && [ -z "$INSTALL_CLIENTS" ]; then
  # No flags — check env var
  if [ -n "$PONTIS_INSTALL_CLIENTS" ]; then
    if [ "$PONTIS_INSTALL_CLIENTS" = "all" ] || [ "$PONTIS_INSTALL_CLIENTS" = "true" ]; then
      CLIENTS_TO_INSTALL="claude codex opencode pi"
    elif [ "$PONTIS_INSTALL_CLIENTS" = "none" ] || [ "$PONTIS_INSTALL_CLIENTS" = "false" ]; then
      :
    else
      CLIENTS_TO_INSTALL="$PONTIS_INSTALL_CLIENTS"
    fi
  fi
  # No flags at all, no env var → default to Pontis-only (opt-in)
fi

# Remove skipped clients
for skip in $SKIP_CLIENTS; do
  CLIENTS_TO_INSTALL=$(echo "$CLIENTS_TO_INSTALL" | tr ' ' '\n' | grep -v "^$skip$" | tr '\n' ' ' | xargs)
done

# Install each client if not already on PATH
if [ -n "$CLIENTS_TO_INSTALL" ]; then
  info "Checking client tools..."

  # Resolve the pontis CLI to use for client installation
  # If we just installed it, use it directly
  PONTIS_CMD="$INSTALL_DIR/pontis"
  if [ ! -f "$PONTIS_CMD" ]; then
    PONTIS_CMD="pontis"
  fi

  for client in $CLIENTS_TO_INSTALL; do
    # Check if already installed
    if command -v "$client" &> /dev/null; then
      success "$client already on PATH — skipping"
      continue
    fi

    case "$client" in
      claude)
        info "Installing Claude Code..."
        if curl -fsSL https://claude.ai/install.sh | bash; then
          success "Claude Code installed"
        else
          warn "Claude Code installation failed — install manually: curl -fsSL https://claude.ai/install.sh | bash"
        fi
        ;;
      codex)
        info "Installing Codex CLI..."
        if curl -fsSL https://chatgpt.com/codex/install.sh | sh; then
          success "Codex CLI installed"
        else
          warn "Codex CLI installation failed — install manually: curl -fsSL https://chatgpt.com/codex/install.sh | sh"
        fi
        ;;
      opencode)
        info "Installing OpenCode..."
        if curl -fsSL https://opencode.ai/install | bash; then
          success "OpenCode installed"
        else
          warn "OpenCode installation failed — install manually: curl -fsSL https://opencode.ai/install | bash"
        fi
        ;;
      pi)
        info "Installing Pi coding agent..."
        if command -v npm &> /dev/null; then
          # Check Node version
          NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
          if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then
            if npm install -g --ignore-scripts @earendil-works/pi-coding-agent; then
              success "Pi coding agent installed"
            else
              warn "Pi installation failed — install manually: npm install -g @earendil-works/pi-coding-agent"
            fi
          else
            warn "Pi requires Node.js >= 22.19 (current: $(node -v 2>/dev/null || echo 'unknown')) — skipping"
          fi
        else
          warn "npm not found — cannot install Pi. Install manually: npm install -g @earendil-works/pi-coding-agent"
        fi
        ;;
    esac
  done
fi

echo ""
if [ "$PONTIS_OK" = "1" ]; then
  echo "     Run:  pontis"
  echo "           pontis claude  /  pontis codex  /  pontis opencode  /  pontis pi"
  echo ""
  echo "     Manage clients:  pontis install"
fi
