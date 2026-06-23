# Pontis 🌌

**Pontis** is a bidirectional translation proxy and local CLI launcher that allows you to run **Claude Code**, **OpenAI Codex CLI**, and other terminal-based AI harnesses using free-tier models on **OpenCode** or **locally installed models** (Ollama, LM Studio, etc.).

It bridges the gap between Anthropic format (`/v1/messages`), OpenAI chat completions (`/v1/chat/completions`), and OpenAI legacy completions (`/v1/completions`), translating requests, responses, and SSE streams on the fly to match the target engine.

---

## Features

- **🚀 Direct CLI Installation**: Install globally with a single curl command.
- **💻 Local Model Engines**: Support for Ollama, LM Studio, Llama.cpp, and custom local endpoints out of the box with zero external API keys required.
- **✨ Active Model Discovery**: Dynamically scans OpenCode's endpoints or your local model server's `/models` list.
- **👁️ Auto-Vision Format Translation**: Translates Anthropic base64 and URL image blocks into standard OpenAI `image_url` payloads, enabling image inputs if your chosen upstream engine supports vision processing.
- **🔑 Auto-Approved API Keys**: Writes key configurations into your `~/.claude.json` to bypass OAuth redirects automatically.
- **⚙️ OpenAI Completions / Codex Compatibility**: Translates the OpenAI Responses API (used by Codex CLI) to chat completions, including tool calls, tool outputs, and streaming events.

---

## Prerequisites

Before running Pontis, make sure you have:
- **Node.js** (v18 or higher) installed on your system.
- **Claude Code** (optional) installed globally:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
- **Codex CLI** (optional) installed globally:
  ```bash
  npm install -g @openai/codex-cli
  ```
- **Local Engine** (optional, e.g. Ollama or LM Studio) running locally.

---

## Installation

Install Pontis globally using the install script:

```bash
curl -fsL https://pontis.khrees.com/install | bash
```

This clones Pontis to `~/.pontis`, configures local dependencies, and sets up the global `pontis` command symlink in your `PATH`.

---

## Quick Start (Interactive Setup)

1. Launch Pontis CLI:
   ```bash
   pontis
   ```
2. Select your **API Provider**:
   * **OpenCode (Zen/Go)**: Enter your OpenCode API Key when prompted (get one from [opencode.ai](https://opencode.ai/auth)).
   * **Local Models**: Choose from Ollama, LM Studio, Llama.cpp, or enter a custom URL.
3. Select one of the dynamically fetched models available on that provider.
4. Claude Code will boot up automatically using your chosen model configuration!

### Command Subcommands:
You can direct Pontis to launch a specific client interface directly:

* **Claude Code**: `pontis claude`
* **Codex**: `pontis codex`
* **Standalone Server**: `pontis server` (keeps only the proxy server running on `http://localhost:8787` for external API connections)

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
