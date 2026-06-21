#!/usr/bin/env bash

# =============================================
#  OpenCode → Claude Code Bridge
#  Uses OpenCode's free models through
#  the Claude Code terminal harness
# =============================================

set -e

PROXY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_FILE="$HOME/.opencode_api_key"
PORT=8787
PROXY_URL="http://localhost:$PORT"

# ─────────────────────────────────────────────
# 1. Load API Key
# ─────────────────────────────────────────────
if [ -n "$OPENCODE_API_KEY" ]; then
    API_KEY="$OPENCODE_API_KEY"
elif [ -f "$KEY_FILE" ]; then
    API_KEY=$(cat "$KEY_FILE")
else
    echo "============================================="
    echo "      OpenCode API Key Setup Required        "
    echo "============================================="
    echo ""
    echo "To get your key:"
    echo "  1. Go to https://opencode.ai"
    echo "  2. Sign in / create account"
    echo "  3. Navigate to Zen → API Keys"
    echo "  4. Create a new key and copy it"
    echo ""
    read -r -p "Enter your OpenCode API Key: " API_KEY
    if [ -z "$API_KEY" ]; then
        echo "Error: API Key is required."
        exit 1
    fi
    read -r -p "Save this key to $KEY_FILE for future use? (y/n): " SAVE_KEY
    if [[ "$SAVE_KEY" =~ ^[Yy]$ ]]; then
        echo "$API_KEY" > "$KEY_FILE"
        chmod 600 "$KEY_FILE"
        echo "✓ Saved API key to $KEY_FILE"
    fi
fi

# Trim any leading/trailing whitespace, newlines, or carriage returns
API_KEY=$(echo "$API_KEY" | xargs | tr -d '\r')

# ─────────────────────────────────────────────
# 2. Select Model
# ─────────────────────────────────────────────
echo "Fetching available models from OpenCode..."
MODELS_JSON=$(curl -s -H "Authorization: Bearer $API_KEY" https://opencode.ai/zen/v1/models)

# Parse models using Node.js to filter for free ones (ends with -free or is big-pickle, excluding minimax-m3-free)
FREE_MODELS=($(node -e '
try {
  const json = JSON.parse(process.argv[1]);
  if (json && Array.isArray(json.data)) {
    const free = json.data
      .map(m => m.id)
      .filter(id => (id.endsWith("-free") && id !== "minimax-m3-free") || id === "big-pickle");
    console.log(free.join(" "));
  }
} catch (e) {
  // fallback if json parsing fails
}
' "$MODELS_JSON" 2>/dev/null))

# Fallback in case API call or parsing failed
if [ ${#FREE_MODELS[@]} -eq 0 ]; then
  FREE_MODELS=("mimo-v2.5-free" "deepseek-v4-flash-free" "big-pickle" "qwen3.6-plus-free" "nemotron-3-ultra-free" "north-mini-code-free")
fi

echo ""
echo "============================================="
echo "       Select OpenCode Free Model            "
echo "============================================="
for i in "${!FREE_MODELS[@]}"; do
  echo "$((i+1))) ${FREE_MODELS[$i]}"
done
CUSTOM_OPT=$(( ${#FREE_MODELS[@]} + 1 ))
echo "${CUSTOM_OPT}) Custom (enter model ID manually)"

read -r -p "Select option [1-${CUSTOM_OPT}]: " MODEL_OPT

# Check selection
if [[ "$MODEL_OPT" =~ ^[0-9]+$ ]] && [ "$MODEL_OPT" -ge 1 ] && [ "$MODEL_OPT" -le "${#FREE_MODELS[@]}" ]; then
  MODEL="${FREE_MODELS[$((MODEL_OPT-1))]}"
elif [ "$MODEL_OPT" -eq "${CUSTOM_OPT}" ]; then
  read -r -p "Enter custom model ID: " MODEL
  if [ -z "$MODEL" ]; then
    echo "Error: Model ID cannot be empty."
    exit 1
  fi
else
  # Default to the first model in the list
  MODEL="${FREE_MODELS[0]}"
  echo "Defaulting to $MODEL"
fi

echo "Selected Model: $MODEL"

# ─────────────────────────────────────────────
# 3. Start/Reuse Proxy
# ─────────────────────────────────────────────
if lsof -i :$PORT >/dev/null 2>&1; then
    echo "⚡ Using existing proxy on port $PORT."
    LAUNCH_PROXY=false
else
    LAUNCH_PROXY=true
fi

PROXY_PID=""

cleanup() {
    if [ "$LAUNCH_PROXY" = true ] && [ -n "$PROXY_PID" ]; then
        echo ""
        echo "Stopping local OpenCode proxy..."
        kill "$PROXY_PID" 2>/dev/null || true
        wait "$PROXY_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

if [ "$LAUNCH_PROXY" = true ]; then
    echo "Starting local OpenCode proxy server..."

    # Ensure dependencies are installed
    if [ ! -d "$PROXY_DIR/node_modules" ]; then
        echo "Installing proxy dependencies..."
        (cd "$PROXY_DIR" && npm install --silent 2>/dev/null)
    fi

    # Start local server
    PROXY_LOG="$PROXY_DIR/proxy.log"
    (cd "$PROXY_DIR" && npx tsx src/local-server.ts > "$PROXY_LOG" 2>&1) &
    PROXY_PID=$!

    # Wait for proxy to become ready
    echo -n "Waiting for proxy"
    for i in {1..30}; do
        if curl -s -f "$PROXY_URL/" >/dev/null 2>&1; then
            echo " ✓ Ready!"
            break
        fi
        sleep 0.5
        echo -n "."
        if [ $i -eq 30 ]; then
            echo ""
            echo "Error: Proxy failed to start on port $PORT within 15 seconds."
            echo "Check logs: $PROXY_LOG"
            exit 1
        fi
    done
else
    echo "Using existing service on port $PORT."
fi

# ─────────────────────────────────────────────
# 4. Quick connectivity test
# ─────────────────────────────────────────────
echo -n "Testing API connectivity..."

TEST_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$PROXY_URL/zen/v1/messages" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -d '{
        "model": "'"$MODEL"'",
        "max_tokens": 5,
        "messages": [{"role": "user", "content": "hi"}]
    }' 2>/dev/null || echo "CURL_FAILED")

if echo "$TEST_RESPONSE" | grep -q "CURL_FAILED"; then
    echo " ⚠ Could not reach proxy (continuing anyway)"
else
    HTTP_CODE=$(echo "$TEST_RESPONSE" | tail -1)
    BODY=$(echo "$TEST_RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" = "200" ] || echo "$BODY" | grep -q '"type":"message"'; then
        echo " ✓ Connected!"
    elif [ "$HTTP_CODE" = "401" ]; then
        echo ""
        echo "⚠ API returned 401 Unauthorized."
        echo "  Your API key may be invalid or expired."
        echo "  Response: $(echo "$BODY" | head -c 200)"
        echo ""
        read -r -p "Continue anyway? (y/n): " CONTINUE
        if [[ ! "$CONTINUE" =~ ^[Yy]$ ]]; then
            exit 1
        fi
    else
        # Non-200 but not 401 — may still work for streaming
        echo " ⚠ Got HTTP $HTTP_CODE (continuing — streaming may work)"
    fi
fi

# ─────────────────────────────────────────────
# 5. Launch Claude Code
# ─────────────────────────────────────────────
echo ""
echo "============================================="
echo " Launching Claude Code with OpenCode Harness "
echo "============================================="
echo "Proxy:    $PROXY_URL/zen"
echo "Model:    $MODEL"
echo ""

# Auto-approve the API key in ~/.claude.json to prevent OAuth fallback / prompt
node -e '
const fs = require("fs");
const path = require("path");
const configFile = path.join(process.env.HOME, ".claude.json");
const keySuffix = process.argv[1].slice(-20);
if (fs.existsSync(configFile)) {
  try {
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (!config.customApiKeyResponses) config.customApiKeyResponses = {};
    if (!config.customApiKeyResponses.approved) config.customApiKeyResponses.approved = [];
    if (!config.customApiKeyResponses.approved.includes(keySuffix)) {
      config.customApiKeyResponses.approved.push(keySuffix);
    }
    if (config.customApiKeyResponses.rejected) {
      config.customApiKeyResponses.rejected = config.customApiKeyResponses.rejected.filter(k => k !== keySuffix);
    }
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");
    console.log("✓ Auto-approved API key suffix in ~/.claude.json");
  } catch (e) {
    console.error("Failed to auto-approve API key in config:", e);
  }
}
' "$API_KEY"

# Core env vars for the Anthropic SDK
export ANTHROPIC_BASE_URL="$PROXY_URL/zen"
export ANTHROPIC_API_KEY="$API_KEY"

# Tell Claude Code to use our OpenCode model for everything:
# - ANTHROPIC_MODEL: the main model used for conversations
# - ANTHROPIC_SMALL_FAST_MODEL: model used for API key verification & quick tasks
#   (without this, Claude Code tries to verify with claude-3-5-haiku which doesn't
#    exist on OpenCode, causing a 401 error)
export ANTHROPIC_MODEL="$MODEL"
export ANTHROPIC_SMALL_FAST_MODEL="$MODEL"

# Execute the global claude binary
claude "$@"
