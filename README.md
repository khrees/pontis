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
- **⚙️ OpenAI Completions / Codex Compatibility**: Directly translates legacy text-completions prompt shapes to chat formats so you can power your Codex CLI using OpenCode or local chat model engines.
  - ⚠️ **Codex CLI support is experimental** — see [known issues](#codex-cli-experimental) below.

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
   * **OpenCode (Zen/Go)**: Enter your OpenCode API Key when prompted (get one from [opencode.ai](https://opencode.ai)).
   * **Local Models**: Choose from Ollama, LM Studio, Llama.cpp, or enter a custom URL.
3. Select one of the dynamically fetched models available on that provider.
4. Claude Code will boot up automatically using your chosen model configuration!

### Command Subcommands:
You can direct Pontis to launch a specific client interface directly:

* **Claude Code**: `pontis claude`
* **Codex CLI** ⚠️: `pontis codex` — see [experimental notes](#codex-cli-experimental)
* **Standalone Server**: `pontis standalone` (keeps only the proxy server running on `http://localhost:8787` for external API connections)

---

## Codex CLI (Experimental) ⚠️

Pontis includes experimental support for OpenAI's [Codex CLI](https://github.com/openai/codex-cli). It works in some configurations but has **known issues**:

- **Streaming responses may not finalize** — the `response.completed` SSE event is missing output and usage data, which can cause Codex CLI to hang after receiving a response.
- **Model discovery is fragile** — Codex CLI may not detect models correctly depending on what version of the OpenAI SDK it's using internally.
- **No conversation continuity** — the `previous_response_id` field is not yet handled, so every request starts a fresh conversation.
- **The `-m` flag** used by the `pontis codex` launcher may not be supported by all versions of the Codex CLI binary.

If you run into issues, try using `pontis standalone` and pointing Codex CLI at the proxy manually:

```bash
# Start the proxy
pontis standalone

# In another terminal, launch Codex CLI pointing at the proxy
export OPENAI_BASE_URL="http://localhost:8787/v1"
export OPENAI_API_KEY="your-opencode-api-key"
codex --model mimo-v2.5-free
```

Contributions to improve Codex CLI support are welcome!

---

## Environment Configuration

You can fully automate Pontis and bypass interactive prompt configuration by setting environment variables in your terminal:

| Variable | Description | Example |
|---|---|---|
| `PONTIS_PROVIDER` | Define provider preset (`opencode` or `local`) | `export PONTIS_PROVIDER="local"` |
| `PONTIS_UPSTREAM_URL` | Upstream base URL targeting the model engine | `export PONTIS_UPSTREAM_URL="http://localhost:11434/v1"` |
| `PONTIS_UPSTREAM_FORMAT` | Upstream API format (`openai`, `anthropic`, or `openai-completions`) | `export PONTIS_UPSTREAM_FORMAT="openai"` |
| `OPENCODE_API_KEY` | OpenCode API credential | `export OPENCODE_API_KEY="sk-..."` |
| `LOCAL_API_KEY` | Key for local setups (if authentication is required) | `export LOCAL_API_KEY="sk-local-test"` |

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

## License & Attribution

This project is licensed under the MIT License.

All credit for the translation layer goes to [@cucoleadan](https://github.com/cucoleadan) based on their work in [opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy).
