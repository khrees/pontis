# Pontis 🌌

**Pontis** is the universal AI gateway and runtime launcher for developer coding agents. It connects any AI coding harness (**Claude Code**, **OpenAI Codex CLI**, **OpenCode**, **Pi**) to any LLM provider (**OpenCode Zen/Go**, **Cloudflare Workers AI**, **local engines** like Ollama, LM Studio, and Llama.cpp, or custom OpenAI/Anthropic-compatible endpoints) with zero friction.

Pontis performs real-time bidirectional protocol translation between **Anthropic Messages** (`/v1/messages`), **OpenAI Chat Completions** (`/v1/chat/completions`), **OpenAI Responses API** (`/v1/responses` via HTTP and WebSocket), and **OpenAI Legacy Completions** (`/v1/completions`) — translating tool calls, reasoning/thinking blocks, prompt caching markers, and streaming events on the fly.

---

## Key Capabilities

- **🌐 Universal Protocol Translation**:
  - **Anthropic Messages ↔ OpenAI Chat**: Run Claude Code against any OpenAI-compatible provider with full tool-calling and image support.
  - **OpenAI Responses API Translation**: Run OpenAI Codex CLI against OpenCode, Cloudflare, or local LLMs with full multi-turn context and streaming event translation.
  - **Multimodal & Vision Translation**: Automatically translates Anthropic base64/URL image blocks into standard OpenAI `image_url` payloads.
  - **Reasoning & Extended Thinking**: Seamlessly preserves and passes deep reasoning tokens (e.g. DeepSeek R1, Kimi, GLM).
  - **Prompt Cache Bridging**: Bridges Anthropic `cache_control` breakpoints with OpenAI prompt caching hash keys.

- **⚡ Coding Agent Lifecycle & Launcher**:
  - Instant 1-click launchers for **Claude Code** (`pontis claude`), **Codex CLI** (`pontis codex`), **OpenCode** (`pontis opencode`), and **Pi** (`pontis pi`).
  - Auto-configures client settings and auth files (`~/.claude.json`, `~/.codex/pontis.config.toml`, `~/.local/share/opencode/auth.json`, `~/.pi/agent/models.json`) in the background.
  - Built-in install engine with automatic PATH resolution and on-demand installation.

- **🔑 Secure Credential Vault & Unified Auth**:
  - AES-256-GCM encrypted local credential storage (`pontis auth`) for OpenCode keys, Cloudflare tokens, and local API keys.
  - No plaintext tokens written to disk.

- **⚙️ Configurable & Extensible**:
  - Deployable as a local proxy (`pontis server`), CLI binary, or Cloudflare Worker.
  - User preference persistence (`pontis config`) and environment variable overrides via `.env`.

---

## Installation

Install Pontis globally using the official installer:

```bash
curl -fsL https://pontis.khrees.com/install | bash
```

Or clone and build locally with Bun:

```bash
git clone https://github.com/khrees2412/pontis.git
cd pontis
bun install
bun run build
```

---

## Quick Start

### 1. Launch Pontis
```bash
pontis
```
- **First time**: Guided 2-step setup (Choose provider → Enter key → Choose coding agent). Your key is automatically encrypted in secure storage.
- **Returning**: Instant **1-click Quick Launch** (press Enter to run your default client & model immediately).

### 2. Direct Client Launchers
Launch your preferred AI coding assistant directly with your saved provider and model:

* **Claude Code**: `pontis claude`
* **Codex CLI**: `pontis codex`
* **OpenCode**: `pontis opencode`
* **Pi**: `pontis pi`
* **Standalone Server**: `pontis server` (runs proxy on `http://localhost:8787` without launching a client)

---

## Authentication & API Keys

Manage credentials across OpenCode, Cloudflare Workers AI, and local engines with the unified `auth` command:

```bash
# View configured credentials & key status
pontis auth list

# Add or update a key (interactive or direct)
pontis auth set opencode
pontis auth set cloudflare
pontis auth set local http://localhost:11434/v1

# Remove a provider's credentials
pontis auth remove opencode
pontis auth remove cloudflare

# Clear all credentials securely
pontis auth clear
```

---

## Coding Agent CLIs

List and manage supported terminal coding assistants:

```bash
# List all clients, installed versions, paths, and status
pontis clients
# or
pontis list

# Set your default launch client
pontis clients default claude
pontis clients default codex

# Install missing clients
pontis install claude
pontis install codex
pontis install pi
```

---

## User Preferences & Defaults

Customize default behavior without having to export environment variables every session:

```bash
# View current preferences
pontis config

# Set default model, client, or provider
pontis config set client codex
pontis config set model deepseek-v4-flash-free
pontis config set provider opencode

# Reset preferences to defaults
pontis config reset
```

---

## Codex CLI

Pontis supports [OpenAI's Codex CLI](https://github.com/openai/codex) out of the box. Run:

```bash
pontis codex
```

Pontis starts the local proxy, selects your model, and launches Codex pointed at `http://localhost:8787/v1`.

### What Pontis handles

- **Responses API translation** — Converts Codex's `/v1/responses` requests (including `function_call`, `function_call_output`, and message items) into chat completions for OpenCode or local engines.
- **Model metadata** — Returns per-model context windows, output limits, and tool capabilities via `/v1/models` so Codex configures itself correctly instead of using fallback defaults.
- **Streaming** — Emits full `response.completed` events with output items and usage data (`stream_options: { include_usage: true }`).
- **Multi-turn context** — Reconstructs conversation history from Codex's input items and caches state for `previous_response_id` follow-ups.

Known model metadata is provided for: `mimo-v2.5-free`, `deepseek-v4-flash-free`, `big-pickle`, `nemotron-3-ultra-free`, `north-mini-code-free`, and `qwen3.6-plus`. Unknown models receive sensible defaults (128K context, 16K max output tokens).

### Manual setup

To run the proxy and Codex separately:

```bash
# Terminal 1 — start the proxy
pontis server

# Terminal 2 — launch Codex
export OPENAI_BASE_URL="http://localhost:8787/v1"
export OPENAI_API_KEY="your-opencode-api-key"
codex --model mimo-v2.5-free
```


---

## Environment Configuration

You can fully automate Pontis and bypass interactive prompt configuration by setting environment variables in your terminal:

| Variable | Description | Example |
|---|---|---|
| `PONTIS_PROVIDER` | Define provider preset (`opencode` or `local`) | `export PONTIS_PROVIDER="local"` |
| `PONTIS_MODEL` | Default free model for remapping and Codex launcher | `export PONTIS_MODEL="deepseek-v4-flash-free"` |
| `PONTIS_UPSTREAM_URL` | Upstream base URL targeting the model engine | `export PONTIS_UPSTREAM_URL="http://localhost:11434/v1"` |
| `PONTIS_UPSTREAM_FORMAT` | Upstream API format (`openai`, `anthropic`, or `openai-completions`) | `export PONTIS_UPSTREAM_FORMAT="openai"` |
| `OPENCODE_API_KEY` | OpenCode API credential | `export OPENCODE_API_KEY="sk-..."` |
| `LOCAL_API_KEY` | Key for local setups (if authentication is required) | `export LOCAL_API_KEY="sk-local-test"` |
| `PONTIS_DEBUG` | Enable verbose proxy request logging | `export PONTIS_DEBUG=true` |
| `PONTIS_CODEX_MODE` | Return Codex-format model metadata from `/v1/models` | `export PONTIS_CODEX_MODE=true` |
| `PONTIS_TIMEOUT_MS` | Upstream request timeout in milliseconds (default 120000) | `export PONTIS_TIMEOUT_MS=30000` |
| `PONTIS_MIN_KEY_LENGTH` | Minimum API key length check (default 32, set 0 to disable) | `export PONTIS_MIN_KEY_LENGTH=0` |

---

## Supported Free Models (OpenCode Zen)

When using the OpenCode provider, Pontis dynamically verifies active models. The typical models include:

- `mimo-v2.5-free` (default)
- `deepseek-v4-flash-free`
- `big-pickle`
- `nemotron-3-ultra-free`
- `north-mini-code-free`

---

## Deployment (Optional)

If you prefer to host this proxy in the cloud instead of running it locally, you can deploy it as a Cloudflare Worker:

```bash
npm install
npm run deploy
```

Once deployed, Cloudflare will output your worker URL (e.g. `https://pontis-proxy.your-subdomain.workers.dev`). You can then configure your CLI clients to target this remote URL instead of the local proxy.

### 1. Configuring Claude Code
Export the `ANTHROPIC_BASE_URL` variable in your terminal pointing to the `/zen` path of your deployed worker:

```bash
export ANTHROPIC_BASE_URL="https://pontis-proxy.your-subdomain.workers.dev/zen"
export ANTHROPIC_API_KEY="your-opencode-api-key"
claude
```

### 2. Configuring OpenAI Codex CLI
Export the `OPENAI_BASE_URL` variable in your terminal pointing to the `/v1` path of your deployed worker:

```bash
export OPENAI_BASE_URL="https://pontis-proxy.your-subdomain.workers.dev/v1"
export OPENAI_API_KEY="your-opencode-api-key"
codex
```

---

## Troubleshooting

### Proxy fails to start (`port already in use`)

A previous instance may still be running. Kill it manually:

```bash
lsof -ti :8787 | xargs kill -9
```

Or restart your terminal / wait 30 seconds for the process to clean up.

### "API key is too short" error

Local providers (Ollama, LM Studio) often use short or dummy keys. Set the minimum length to 0:

```bash
export PONTIS_MIN_KEY_LENGTH=0
```

Pontis's CLI sets this automatically when you select a local provider, but manual setups need it.

### "Upstream did not respond in time" error

The upstream model provider took too long to respond. Pontis defaults to a 120-second timeout. If your model is slow to load (e.g., first-time cold start), increase the timeout:

```bash
export PONTIS_TIMEOUT_MS=300000
```

### Debug logging

To see detailed request translation, set:

```bash
export PONTIS_DEBUG=true
```

You'll see logs prefixed with request IDs like `[req_xxx]` showing how requests are translated and where they're routed. Each request also gets a `X-Request-Id` header in the response for correlation.

### Model not found or wrong metadata

Pontis fetches the model list from the upstream provider and enriches it with known metadata (context window, tool support). If a model is missing, try:

1. Check it's available on the upstream directly: `curl <upstream>/v1/models`
2. Set a default model explicitly: `export PONTIS_MODEL="your-model-id"`
3. For Codex CLI, the model metadata table is in `src/model-metadata.ts` — add an entry if needed

### Proxy shows `502` for all requests

This usually means the upstream provider is unreachable or returning errors:

```bash
# Test the proxy's upstream directly
curl https://opencode.ai/zen/v1/models -H "Authorization: Bearer $OPENCODE_API_KEY"

# Or for local setups
curl http://localhost:11434/v1/models
```

### Request tracing

Every response from the proxy includes an `X-Request-Id` header (e.g., `req_abc123_4f`). Include this ID in any bug reports or when asking for help — it helps correlate proxy logs with upstream behavior.

---

## License & Attribution

This project is licensed under the MIT License.

All credit for the translation layer goes to [@cucoleadan](https://github.com/cucoleadan) based on their work in [opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy).
