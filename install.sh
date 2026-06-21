#!/usr/bin/env bash

# =============================================
#  Pontis Installer 🌌
#  Quick installation script for Pontis CLI
# =============================================

set -e

REPO="khrees/pontis"

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

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo "============================================="
echo -e "          ${GREEN}Pontis CLI Installer 🌌${NC}            "
echo "============================================="
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
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
  warn "Intel Mac detected. If you have Apple Silicon, make sure you're not running under Rosetta."
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

info "Detected System: $OS-$ARCH"

# Check if Node.js is installed (required by clients like Claude Code/Codex)
if ! command -v node &> /dev/null; then
  warn "Node.js is not found. Note that harnesses like Claude Code require Node.js (v18+) to run."
fi

# Create install dir
mkdir -p "$INSTALL_DIR"

# Get latest release tag name
info "Checking latest release on GitHub..."
RELEASE_INFO=$(curl -s https://api.github.com/repos/$REPO/releases/latest || echo "")
TAG_NAME=$(echo "$RELEASE_INFO" | grep -o '"tag_name": "[^"]*' | grep -o '[^"]*$' || echo "")

if [ -z "$TAG_NAME" ]; then
  error "Failed to retrieve latest release version from GitHub API. Please check your internet connection."
fi

info "Latest version found: $TAG_NAME"

# Download launcher script to temp file
LAUNCHER_URL="https://github.com/$REPO/releases/download/$TAG_NAME/pontis"
info "Downloading launcher script..."
TMP_LAUNCHER=$(mktemp)
if ! curl -fL --progress-bar "$LAUNCHER_URL" -o "$TMP_LAUNCHER"; then
  error "Failed to download launcher from $LAUNCHER_URL"
fi
chmod +x "$TMP_LAUNCHER"

# Download proxy binary to temp file
BINARY_URL="https://github.com/$REPO/releases/download/$TAG_NAME/$ASSET_NAME"
info "Downloading precompiled proxy binary ($ASSET_NAME)..."
TMP_BINARY=$(mktemp)
if ! curl -fL --progress-bar "$BINARY_URL" -o "$TMP_BINARY"; then
  error "Failed to download binary from $BINARY_URL"
fi
chmod +x "$TMP_BINARY"

# Install both launcher and binary to destination
info "Installing to $INSTALL_DIR..."
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP_LAUNCHER" "$INSTALL_DIR/pontis"
  mv "$TMP_BINARY" "$INSTALL_DIR/pontis-proxy"
  info "✓ Executables installed successfully."
else
  warn "Elevated permissions (sudo) required to write to $INSTALL_DIR"
  sudo mv "$TMP_LAUNCHER" "$INSTALL_DIR/pontis"
  sudo mv "$TMP_BINARY" "$INSTALL_DIR/pontis-proxy"
  info "✓ Executables installed successfully (via sudo)."
fi

# Verify installation
if command -v pontis &> /dev/null; then
  echo ""
  info "Successfully installed Pontis!"
  echo ""
  echo "  To start Pontis client selection, run:"
  echo "    pontis"
  echo ""
  echo "  To launch Claude Code or Codex directly:"
  echo "    pontis claude"
  echo "    pontis codex"
  echo ""
else
  warn "Installed but 'pontis' not found in PATH. You may need to add $INSTALL_DIR to your PATH."
fi
