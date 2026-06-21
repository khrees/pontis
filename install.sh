#!/usr/bin/env bash

# =============================================
#  Pontis Installer 🌌
#  Quick installation script for Pontis CLI
# =============================================

set -e

echo "============================================="
echo "          Pontis CLI Installer 🌌            "
echo "============================================="
echo ""

# Helper function to run commands with a loading spinner
run_with_spinner() {
  local message="$1"
  shift
  "$@" >/dev/null 2>&1 &
  local pid=$!
  local spin='|/-\'
  while kill -0 $pid 2>/dev/null; do
    printf "\r%s... [%c] " "$message" "$spin"
    spin=${spin#?}${spin%?}
    sleep 0.1
  done
  wait $pid
  local exit_code=$?
  if [ $exit_code -eq 0 ]; then
    printf "\r%s... Done!      \n" "$message"
    return 0
  else
    printf "\r%s... Failed!    \n" "$message"
    return 1
  fi
}

# 1. Check prerequisites
echo "Checking prerequisites..."

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Error: Node.js is not installed."
  echo "Please install Node.js (v18 or higher) before continuing."
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2)
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'.' -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Error: Node.js version is $NODE_VERSION."
  echo "Pontis requires Node.js v18 or higher."
  exit 1
fi
echo "✓ Node.js ($NODE_VERSION) found."

# Check Git
if ! command -v git >/dev/null 2>&1; then
  echo "❌ Error: Git is not installed."
  echo "Please install Git before continuing."
  exit 1
fi
echo "✓ Git found."

# 2. Clone Repository
INSTALL_DIR="$HOME/.pontis"

if [ -d "$INSTALL_DIR" ]; then
  echo "Pontis directory already exists at $INSTALL_DIR."
  read -r -p "Do you want to reinstall and overwrite it? (y/n): " REINSTALL
  if [[ "$REINSTALL" =~ ^[Yy]$ ]]; then
    rm -rf "$INSTALL_DIR"
  else
    echo "Installation cancelled."
    exit 0
  fi
fi

# We clone the repo using spinner
run_with_spinner "Cloning Pontis repository" git clone https://github.com/khrees/pontis.git "$INSTALL_DIR"

# 3. Install Dependencies
echo "Setting up dependencies..."
run_with_spinner "Installing Node modules" npm --prefix "$INSTALL_DIR" install --silent

# Ensure the executable file has correct permissions
chmod +x "$INSTALL_DIR/pontis"

# 4. Create global command (Symlink)
echo "Creating global command symlink..."
src_file="$INSTALL_DIR/pontis"
dest_file="/usr/local/bin/pontis"

if [ -w "/usr/local/bin" ]; then
  ln -sf "$src_file" "$dest_file"
  echo "✓ Symlink created at $dest_file"
elif command -v sudo >/dev/null 2>&1; then
  echo "Creating symlink in /usr/local/bin (requires administrator password)..."
  sudo ln -sf "$src_file" "$dest_file"
  echo "✓ Symlink created at $dest_file (via sudo)"
else
  # Fallback to local bin if in PATH
  local_bin="$HOME/.local/bin"
  mkdir -p "$local_bin"
  ln -sf "$src_file" "$local_bin/pontis"
  echo "✓ Created symlink at $local_bin/pontis"
  if [[ ":$PATH:" != *":$local_bin:"* ]]; then
    echo "⚠ Note: $local_bin is not in your PATH. You might need to add it to your shell config."
  fi
fi

# 5. Check client prerequisites
echo ""
echo "Checking client configurations..."

# Check Claude Code
if command -v claude >/dev/null 2>&1; then
  echo "✓ Claude Code CLI found."
else
  echo "💡 Tip: Claude Code is not installed. To install it, run:"
  echo "  npm install -g @anthropic-ai/claude-code"
fi

# Check Codex CLI
if command -v codex >/dev/null 2>&1 || command -v openai-codex >/dev/null 2>&1; then
  echo "✓ Codex CLI found."
else
  echo "💡 Tip: Codex CLI is not installed. If you want to use Codex completions, run:"
  echo "  npm install -g @openai/codex-cli"
fi

echo ""
echo "============================================="
echo "        Pontis Successfully Installed! 🚀     "
echo "============================================="
echo "To start Pontis, run:"
echo "  pontis"
echo ""
echo "To launch Codex CLI directly with OpenCode:"
echo "  pontis codex"
echo ""
