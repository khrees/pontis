# Pontis 🌌
**Bridge any AI coding agent CLI to any LLM provider — with zero config.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](https://github.com/khrees/pontis/blob/main/LICENSE)
[![Release](https://img.shields.io/github/v/release/khrees/pontis?include_prereleases&color=00f2fe)](https://github.com/khrees/pontis/releases)
[![Build Status](https://img.shields.io/github/actions/workflow/status/khrees/pontis/release.yml)](https://github.com/khrees/pontis/actions)

---

Coding harnesses like **Claude Code** and **OpenAI Codex CLI** are built around proprietary cloud models. **Pontis** breaks the lock-in.

Pontis is a universal gateway and runtime launcher that translates real-time agent protocols (Anthropic Messages, OpenAI Chat, and Responses API). Run **Claude Code**, **Codex**, **Hermes Agent**, **OpenCode**, or **Pi** against **Google**, **OpenCode**, **Cloudflare Workers AI**, or your **local Ollama / LM Studio models** without touching configuration files.

```
┌────────────────────────────────────────────────────────────────────────┐
│                  Coding Agent CLIs (Terminal Harnesses)                │
│       Claude Code · Codex CLI · Hermes Agent · OpenCode · Pi           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │   PONTIS GATEWAY    │  ◄── Real-time Protocol Translation
                         │  (Local Proxy/CLI)  │      · Tool Calling & Streaming
                         └──────────┬──────────┘      · Reasoning Tokens & Context
                                    │                 · Encrypted Credential Vault
┌───────────────────────────────────┴────────────────────────────────────┐
│                         LLM Backends & Providers                       │
│    Google Gemini · OpenCode Zen/Go · Cloudflare · Local                │
│           (Gemini 2.5, DeepSeek, Kimi, Qwen, Ollama, LM Studio)        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ 60-Second Quick Start

### 1. Install Pontis

#### Stable Release (Recommended)
```bash
curl -fsSL https://pontis.khrees.com/install | bash
```

#### Install with All Agent CLIs
To install Pontis alongside Claude Code, Codex, Hermes Agent, OpenCode, and Pi in one command:
```bash
curl -fsSL https://pontis.khrees.com/install | bash -s -- --with-clients
```

#### Install Nightly / Pre-release Channel
To try cutting-edge features and newly supported upstream models:
```bash
# Using installer flag
curl -fsSL https://pontis.khrees.com/install | bash -s -- --nightly

# Or via environment variable
curl -fsSL https://pontis.khrees.com/install | PONTIS_VERSION=nightly bash
```

### 2. Launch
```bash
pontis
```
* **First Launch**: Guided 2-step setup. Choose your provider, paste your key (AES-256 encrypted), and pick your agent.
* **Subsequent Launches**: Instant **1-Click Quick Launch** (press Enter to run your default stack immediately).

---

## 🚀 Direct Agent Launchers

Launch your favorite assistant directly with your active configuration:

```bash
pontis claude       # Launch Claude Code via Pontis
pontis codex        # Launch OpenAI Codex CLI via Pontis
pontis hermes       # Launch Hermes Agent via Pontis
pontis opencode     # Launch OpenCode via Pontis
pontis pi           # Launch Pi via Pontis
pontis server       # Run proxy server only (http://localhost:8787)
```

---

## 🧭 Compatibility Matrix

| Client Harness | Native Protocol | Supported Upstreams | Key Features Handled |
| :--- | :--- | :--- | :--- |
| **Claude Code** | Anthropic Messages (`/v1/messages`) | Google, OpenCode, Cloudflare, Local | Tool use translation, vision/image remapping, prompt cache markers |
| **Codex CLI** | OpenAI Responses API (`/v1/responses`) | Google, OpenCode, Cloudflare, Local | Turn caching (`previous_response_id`), model metadata generation, event streaming |
| **Hermes Agent** | OpenAI Chat Completions | Google, OpenCode, Cloudflare, Local | Autonomous agent execution, dynamic base URL and model injection |
| **OpenCode** | OpenAI / Custom | Google, OpenCode, Cloudflare, Local | Automatic `auth.json` management, dynamic model remapping |
| **Pi** | Custom Provider | Google, OpenCode, Cloudflare, Local | Auto-injected `models.json` profile, dynamic API key resolution |

---

## ⚙️ Configuration & Management

### Providers & Models
Pontis performs real-time discovery against your active engine (no hardcoded fallback lists):

```bash
# Discover live models for a provider
pontis models -p google         # Queries live Gemini & Gemma models
pontis models -p local          # Scans running Ollama / LM Studio models
pontis models -p opencode       # Queries active OpenCode models
pontis models -p cloudflare     # Queries Cloudflare Workers AI models

# Switch active provider or model
pontis config set provider google
pontis config set model gemini-2.5-flash

pontis config set provider local
pontis config set model qwen3.5:latest

pontis config set provider opencode
pontis config set model deepseek-v4-flash-free

# View current preferences
pontis config
```

### Secure Auth Vault (AES-256-GCM)
Keys are encrypted on disk in `~/.pontis/credentials.enc` — never stored in plaintext.
The vault uses AES-256-GCM with a random per-installation key (`~/.pontis/.secret`,
`0600`). This protects keys against casual inspection and plaintext-at-rest exposure
(e.g. in backups or a stolen disk image); note that, like most local CLIs, the key is
stored under your OS user, so it is not a defense against malware already running as
you. Stored writes are atomic, and a corrupt key is backed up (never silently
overwritten) so existing credentials aren't bricked without warning.

```bash
pontis auth list                # Check configured providers and key status
pontis auth set google          # Save free Google AI Studio API key
pontis auth set opencode        # Save OpenCode API key
pontis auth set cloudflare      # Save Cloudflare Account ID & API Token
pontis auth set local           # Set local endpoint (default: http://localhost:11434/v1)
pontis auth clear               # Wipe all stored credentials
```

### Manage Agent CLIs
```bash
pontis clients                  # View installed agent CLIs and versions
pontis install claude           # Install missing client CLI
pontis install hermes
pontis install codex
```

---

## ⚠️ Important: Model Switching Inside Sessions

When an agent is launched through Pontis, the session is tied to your configured Pontis provider and model.

> [!WARNING]
> **Do not switch to native model names (`claude-3-7-sonnet`, `gpt-5.3-codex`) inside the client CLI's in-session `/model` switcher.**
>
> * **Why?** Upstreams like Ollama or OpenCode do not host proprietary OpenAI/Anthropic model weights. Pontis translates generic client requests to your active Pontis model, or the upstream will return `404 Not Found`.
> * **Want to use your native Claude Pro or OpenAI Plus subscription?** Launch `claude` or `codex` directly without Pontis.
> * **Want to change models in Pontis?** Switch before launching using `pontis config set model <model>` or through the interactive launcher.

---

## 🔧 Environment Variables (Optional Automation)

Bypass interactive menus by setting environment variables in CI/CD or automation scripts:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PONTIS_PROVIDER` | Provider preset (`opencode`, `cloudflare`, `local`) | `opencode` |
| `PONTIS_MODEL` | Active model identifier | Provider default |
| `PONTIS_UPSTREAM_URL` | Custom upstream base URL | Provider default |
| `PONTIS_UPSTREAM_FORMAT` | Upstream format (`openai`, `anthropic`, `openai-completions`) | `openai` |
| `OPENCODE_API_KEY` | OpenCode API token | — |
| `LOCAL_API_KEY` | Local engine API key (if required) | Dummy key |
| `PONTIS_DEBUG` | Enable verbose translation logging | `false` |
| `PONTIS_TIMEOUT_MS` | Upstream request timeout (ms) | `120000` (2 min) |

---

## 🛠️ Deployment as Cloudflare Worker (Optional)

Deploy Pontis as a centralized remote proxy on Cloudflare Workers:

```bash
npm install
npm run deploy
```

Configure your local CLI clients to use your remote endpoint:
```bash
export ANTHROPIC_BASE_URL="https://pontis-proxy.<your-subdomain>.workers.dev/zen"
export ANTHROPIC_API_KEY="your-opencode-api-key"
claude
```

---

## 🔍 Comprehensive Troubleshooting Guide

<details>
<summary><b>1. 429 Too Many Requests / Exceeded Rate Limits</b></summary>

* **Cause**: OpenCode free-tier models (like `mimo-v2.5-free`) have rate limits per minute (RPM). Fast sub-queries from agents like Codex or Claude can exhaust this quickly.
* **Remedies**:
  1. Switch to a faster OpenCode model with separate rate limit buckets:
     ```bash
     pontis config set model deepseek-v4-flash-free
     # or
     pontis config set model nemotron-3.5-lightning-free
     ```
  2. Switch to **Local Ollama** (zero rate limits, zero queues):
     ```bash
     pontis config set provider local
     pontis config set model qwen3.5:latest
     ```
  3. Switch to **Cloudflare Workers AI** for dedicated enterprise quotas.
</details>

<details>
<summary><b>2. 404 Not Found: Model Not Found</b></summary>

* **Cause**: The active model name is not pulled on your local engine or is misspelled.
* **Remedies**:
  1. Check what models are currently loaded in your local engine:
     ```bash
     pontis models -p local
     ```
  2. If using Ollama, pull the desired model:
     ```bash
     ollama pull qwen3.5:latest
     pontis config set model qwen3.5:latest
     ```
</details>

<details>
<summary><b>3. 401 / 403 Authentication Failed</b></summary>

* **Cause**: Invalid or expired API key / token.
* **Remedies**:
  1. Re-configure your API key:
     ```bash
     pontis auth set opencode
     # or
     pontis auth set cloudflare
     ```
  2. Verify that your OpenCode key is active at [opencode.ai/auth](https://opencode.ai/auth) $\rightarrow$ Zen $\rightarrow$ API Keys.
</details>

<details>
<summary><b>4. Port 8787 Already in Use</b></summary>

* **Cause**: An earlier proxy instance was left running in the background.
* **Remedy**: Kill the orphaned process on port 8787:
  ```bash
  lsof -ti :8787 | xargs kill -9
  ```
</details>

<details>
<summary><b>5. 502 Bad Gateway / Upstream Unreachable</b></summary>

* **Cause**: The upstream engine is not running, blocked by firewall, or DNS failed.
* **Remedies**:
  1. Test Ollama connectivity:
     ```bash
     curl http://localhost:11434/v1/models
     ```
  2. Test OpenCode connectivity:
     ```bash
     curl https://opencode.ai/zen/v1/models -H "Authorization: Bearer $OPENCODE_API_KEY"
     ```
  3. Ensure your local engine (Ollama, LM Studio, or vLLM) is started.
</details>

<details>
<summary><b>6. Request Tracing & Detailed Debug Logs</b></summary>

* Every response includes an `X-Request-Id` header (e.g. `req_abc123_4f`).
* Enable live translation inspection to view how prompts, tools, and responses are bridged:
  ```bash
  export PONTIS_DEBUG=true
  pontis claude
  ```
</details>

<details>
<summary><b>7. Request Timeout ("Upstream did not respond in time")</b></summary>

* **Cause**: Heavy local models (e.g. 70B parameters) taking time to cold-start or evaluate long prompt contexts.
* **Remedy**: Increase the upstream timeout (default 120 seconds):
  ```bash
  export PONTIS_TIMEOUT_MS=300000 # 5 minutes
  ```
</details>

---

## 📜 License & Attribution

Licensed under the [MIT License](LICENSE).

Special thanks and credit to [@cucoleadan](https://github.com/cucoleadan) for the foundational protocol translation work in [opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy).
