# Openthropic 🌌

**Openthropic** is a bidirectional translation proxy and local CLI launcher that allows you to run **Claude Code** (and other Anthropic-compatible clients) using free-tier models on **OpenCode**.

It bridges the gap between Anthropic's format (which Claude Code uses) and OpenAI's format (which OpenCode Go/Zen mostly use), handles reasoning tokens for models like DeepSeek, and manages model selection on the fly.

> [!NOTE]
> This project is built on top of the excellent translation layer from [opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy) by [@cucoleadan](https://github.com/cucoleadan).

---

## Features

- **🚀 One-command local setup**: Run `./openthropic.sh` to instantly start the proxy and launch Claude Code in one go.
- **✨ Dynamic Free Model Discovery**: Automatically queries the OpenCode API to check which free models are active, presenting you with an up-to-date selection menu (unsupported/ended promotion models like `minimax-m3-free` are automatically filtered out).
- **👁️ Auto-Vision / Image Support**: If you attach images in Claude Code, Openthropic automatically routes those requests to the vision-capable `qwen3.6-plus` model transparently.
- **🔑 Auto-Approved API Keys**: Automatically writes the key approval configuration into your `~/.claude.json` to prevent Claude Code from redirecting you to web OAuth.

---

## Quick Start (Local Run)

1. Clone or download this repository.
2. Run the launcher script:
   ```bash
   ./openthropic.sh
   ```
3. Enter your OpenCode API Key when prompted (get one from [opencode.ai](https://opencode.ai)). The script will save it to `~/.opencode_api_key` so you only have to enter it once.
4. Select one of the fetched free models.
5. Claude Code will boot up automatically using your chosen model!

---

## Supported Free Models (OpenCode Zen)

Openthropic fetches models dynamically. The standard active free models are:

- `mimo-v2.5-free` (Recommended default)
- `deepseek-v4-flash-free`
- `big-pickle`
- `qwen3.6-plus-free`
- `nemotron-3-ultra-free`
- `north-mini-code-free`

*Note: `minimax-m3-free` is explicitly blocked because its free tier promotion has expired.*

---

## Deployment (Optional)

If you prefer to host this proxy in the cloud instead of running it locally, you can deploy it as a Cloudflare Worker:

```bash
npm install
npm run deploy
```

Then configure your custom worker URL inside Claude Code's gateway settings.

---

## Uploading to GitHub

To put this repository on your own GitHub account, run these commands:

1. **Initialize Git & Commit**:
   ```bash
   git init
   git add .
   git commit -m "Initial commit of Openthropic"
   ```
2. **Create GitHub Repo and Push** (requires [GitHub CLI](https://cli.github.com/)):
   ```bash
   gh repo create openthropic --public --source=. --remote=origin --push
   ```

---

## License & Attribution

This project is licensed under the MIT License. 

It is a package of the local wrapper script and the translation core from [opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy). All credit for the translation layer goes to [@cucoleadan](https://github.com/cucoleadan).
