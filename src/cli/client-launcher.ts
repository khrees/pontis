import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { t, SYM, badge, kv, createSpinner, warn } from "./ui";
import { redactKey } from "../redact";
import { PROXY_URL } from "./proxy-manager";
import { PI_AGENT_DIR, PI_MODELS_FILE, OPENCODE_AUTH_FILE, OPENCODE_DATA_DIR } from "./config";
import {
  isInstalled,
  ensureClientInstalled,
  resolveClientBinary,
  type ClientName,
} from "./install-engine";

export function autoApproveClaudeKey(apiKey: string) {
  try {
    const configFile = join(homedir(), ".claude.json");
    const keySuffix = apiKey.slice(-20);
    if (existsSync(configFile)) {
      const config = JSON.parse(readFileSync(configFile, "utf-8"));
      if (!config.customApiKeyResponses) config.customApiKeyResponses = {};
      if (!config.customApiKeyResponses.approved)
        config.customApiKeyResponses.approved = [];
      // Respect the user's decision — never override a rejected key
      if (
        Array.isArray(config.customApiKeyResponses.rejected) &&
        config.customApiKeyResponses.rejected.includes(keySuffix)
      ) {
        badge(
          "warning",
          "API key was previously rejected in Claude — skipping auto-approval",
        );
        return;
      }
      if (!config.customApiKeyResponses.approved.includes(keySuffix)) {
        config.customApiKeyResponses.approved.push(keySuffix);
        badge("muted", "Auto-approved Pontis API key in ~/.claude.json");
      }
      writeFileSync(configFile, JSON.stringify(config, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
    }
  } catch {}
}

// ──────────────────────────────────────────────
//  Generic install check (delegates to install-engine)
// ──────────────────────────────────────────────

/**
 * Check if a client binary is on PATH.
 * Lightweight wrapper so existing code doesn't need to change.
 */
export function clientBinaryExists(name: ClientName): boolean {
  return isInstalled(name);
}

/**
 * Ensure a client is installed before launching.
 * If missing, prompts to install (unless --no-install).
 */
export async function ensureClientReady(
  name: ClientName,
  autoInstall?: boolean,
): Promise<boolean> {
  return ensureClientInstalled(name, {
    autoInstall,
    interactive: autoInstall !== false,
  });
}

// ──────────────────────────────────────────────
//  Pi-specific helpers (unchanged)
// ──────────────────────────────────────────────

const PI_PROVIDER_NAME = "pontis";

/** Check if the `pi` binary is on PATH. */
export function piBinaryExists(): boolean {
  return isInstalled("pi");
}

/**
 * Prompt the user to install Pi if missing. Returns true once installed.
 * Delegates to the generic install engine for consistency.
 */
export async function ensurePiInstalled(): Promise<boolean> {
  return ensureClientReady("pi", true);
}

export const PI_SETTINGS_FILE = join(PI_AGENT_DIR, "settings.json");
export const PI_AUTH_FILE = join(PI_AGENT_DIR, "auth.json");

/**
 * Write (or merge into) `~/.pi/agent/models.json` with a custom "pontis"
 * provider that routes through the local Pontis proxy.
 * Includes at least one model definition so Pi's resolver can find the provider
 * and use buildFallbackModel for any additional model IDs the user requests.
 * Also ensures a minimal settings.json exists so Pi doesn't enter first-time setup.
 */
export function setupPiProvider(apiKey: string, model?: string): void {
  mkdirSync(PI_AGENT_DIR, { recursive: true, mode: 0o700 });

  // ── models.json ──
  let existing: Record<string, unknown> = {};
  if (existsSync(PI_MODELS_FILE)) {
    try {
      existing = JSON.parse(readFileSync(PI_MODELS_FILE, "utf-8"));
    } catch {
      // Corrupt file — start fresh
    }
  }

  const selectedModel = model ?? "default-model";
  const merged = {
    ...existing,
    providers: {
      ...((existing.providers as Record<string, unknown>) || {}),
      [PI_PROVIDER_NAME]: {
        baseUrl: `${PROXY_URL}/v1`,
        apiKey,
        api: "openai-completions",
        models: [
          {
            id: selectedModel,
            contextWindow: 128_000,
            maxTokens: 16_384,
            input: ["text"],
          },
        ],
      },
    },
  };

  writeFileSync(PI_MODELS_FILE, JSON.stringify(merged, null, 2), {
    mode: 0o600,
  });

  // ── settings.json (only if absent) ──
  if (!existsSync(PI_SETTINGS_FILE)) {
    writeFileSync(
      PI_SETTINGS_FILE,
      JSON.stringify(
        {
          defaultProvider: PI_PROVIDER_NAME,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
}

/**
 * Remove the "pontis" provider from `~/.pi/agent/models.json`.
 * Idempotent — safe to call even if the file doesn't exist.
 */
// ──────────────────────────────────────────────
//  OpenCode provider configuration
// ──────────────────────────────────────────────

const OPENCODE_PROVIDER_ID = "openai";

/**
 * Write an auth entry for OpenCode's `openai` provider pointing at the
 * Pontis proxy. OpenCode reads credentials from ~/.local/share/opencode/auth.json
 * and does NOT respect OPENAI_BASE_URL / OPENAI_API_KEY env vars.
 */
export function setupOpenCodeProvider(apiKey: string): void {
  mkdirSync(OPENCODE_DATA_DIR, { recursive: true, mode: 0o700 });

  let existing: Record<string, any> = {};
  if (existsSync(OPENCODE_AUTH_FILE)) {
    try {
      existing = JSON.parse(readFileSync(OPENCODE_AUTH_FILE, "utf-8"));
    } catch {
      // Corrupt file — start fresh
    }
  }

  existing[OPENCODE_PROVIDER_ID] = {
    apiKey,
    baseUrl: `${PROXY_URL}/v1`,
  };

  writeFileSync(OPENCODE_AUTH_FILE, JSON.stringify(existing, null, 2), {
    mode: 0o600,
  });
}

/**
 * Remove the Pontis proxy entry from OpenCode's auth file.
 * Only removes the entry if it points at localhost:8787 (our proxy).
 */
export function cleanupOpenCodeProvider(): void {
  if (!existsSync(OPENCODE_AUTH_FILE)) return;

  try {
    const raw = readFileSync(OPENCODE_AUTH_FILE, "utf-8");
    const content = JSON.parse(raw);
    const entry = content[OPENCODE_PROVIDER_ID];

    if (entry && typeof entry.baseUrl === "string" && entry.baseUrl.includes("localhost:8787")) {
      delete content[OPENCODE_PROVIDER_ID];

      if (Object.keys(content).length === 0) {
        unlinkSync(OPENCODE_AUTH_FILE);
      } else {
        writeFileSync(OPENCODE_AUTH_FILE, JSON.stringify(content, null, 2), {
          mode: 0o600,
        });
      }
    }
  } catch {
    // Leave a corrupt file alone
  }
}

export function cleanupPiProvider(): void {
  if (!existsSync(PI_MODELS_FILE)) return;

  try {
    const raw = readFileSync(PI_MODELS_FILE, "utf-8");
    const content = JSON.parse(raw);

    if (content.providers?.[PI_PROVIDER_NAME]) {
      delete content.providers[PI_PROVIDER_NAME];

      const keys = Object.keys(content);
      if (
        keys.length === 1 &&
        keys[0] === "providers" &&
        Object.keys(content.providers).length === 0
      ) {
        unlinkSync(PI_MODELS_FILE);
      } else {
        writeFileSync(PI_MODELS_FILE, JSON.stringify(content, null, 2), {
          mode: 0o600,
        });
      }
    }
  } catch {
    // Leave a corrupt file alone
  }
}

// ──────────────────────────────────────────────
//  Codex provider configuration
// ──────────────────────────────────────────────

const CODEX_PROVIDER_ID = "pontis";

/**
 * Write a Pontis profile config for Codex at ~/.codex/pontis.config.toml.
 *
 * This follows Ollama's approach: use a dedicated profile file with a
 * [model_providers.<name>] section and `wire_api = "responses"` so Codex
 * sends HTTP requests to the Pontis proxy instead of WebSocket to
 * api.openai.com. No /etc/hosts or pf redirect is needed.
 *
 * Codex uses the profile via: codex --profile pontis
 */
export function setupCodexProvider(): void {
  const dir = join(homedir(), ".codex");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Write a separate profile config (like Ollama does with ollama-launch.config.toml)
  // instead of modifying the main config.toml.
  const profilePath = join(dir, `${CODEX_PROVIDER_ID}.config.toml`);
  const profileContent = `\
model_provider = "${CODEX_PROVIDER_ID}"

[model_providers.${CODEX_PROVIDER_ID}]
name = "Pontis Proxy"
base_url = "http://localhost:8787/v1"
wire_api = "responses"
`;
  writeFileSync(profilePath, profileContent, { mode: 0o600 });
}

/**
 * Remove the Pontis profile config from ~/.codex/.
 */
export function cleanupCodexProvider(): void {
  const profilePath = join(homedir(), ".codex", `${CODEX_PROVIDER_ID}.config.toml`);
  try {
    if (existsSync(profilePath)) unlinkSync(profilePath);
  } catch {
    // Best effort
  }
}



export function launchClient(
  clientCmd: string,
  model: string,
  apiKey: string,
  extraArgs: string[],
): Promise<void> {
  // Section header
  const CLIENT_DISPLAY_NAMES: Record<string, string> = {
    codex: "Codex",
    server: "Server Mode",
    pi: "Pi",
    opencode: "OpenCode",
    claude: "Claude Code",
  };
  const clientDisplayName = CLIENT_DISPLAY_NAMES[clientCmd] || "Claude Code";
  console.log(
    `\n  ${t.primary(SYM.bullet)}  ${t.bold("Launching " + clientDisplayName)}`,
  );
  console.log(`  ${t.muted(SYM.separator.repeat(28))}\n`);

  kv("Proxy", t.secondary(PROXY_URL));
  kv("Model", t.primary(model));
  if (extraArgs.length > 0) kv("Args", t.muted(extraArgs.join(" ")));
  console.log();

  if (clientCmd === "server") {
    badge("info", "Proxy is live — connect your clients");
    console.log(`  Press Ctrl+C to stop\n`);
    return new Promise(() => {}); // hang
  }

  const childEnv: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;

  switch (clientCmd) {
    case "codex":
      // Use dedicated Pontis profile: --profile pontis + proxy base URL
      // This tells Codex to route through Pontis Responses API at http://localhost:8787/v1
      childEnv.OPENAI_BASE_URL = `${PROXY_URL}/v1`;
      childEnv.OPENAI_API_KEY = apiKey;
      childEnv.PONTIS_API_KEY = apiKey;
      if (!extraArgs.includes("--profile") && !extraArgs.includes("-p")) {
        extraArgs = ["--profile", CODEX_PROVIDER_ID, ...extraArgs];
      }
      if (!extraArgs.includes("--model") && !extraArgs.includes("-m")) {
        extraArgs = extraArgs.concat("--model", model);
      }
      break;
    case "pi":
      // Pi uses a custom provider written to models.json that points at the proxy.
      // The API key is embedded in that provider config, but we also pass --api-key
      // which is the most reliable way Pi resolves credentials (takes priority over
      // models.json and env vars).
      childEnv.PONTIS_API_KEY = apiKey;
      childEnv.OPENAI_API_KEY = apiKey;
      extraArgs = [
        "--provider",
        PI_PROVIDER_NAME,
        "--model",
        model,
        "--api-key",
        apiKey,
        ...extraArgs,
      ];
      break;
    case "opencode":
      // OpenCode uses provider/model notation and reads credentials from
      // ~/.local/share/opencode/auth.json (not env vars).
      // The auth file was written by setupOpenCodeProvider() before launch.
      // We pass the model as openai/<model> since Pontis speaks OpenAI format.
      if (!extraArgs.includes("--model")) {
        extraArgs = ["--model", `openai/${model}`, ...extraArgs];
      }
      // Skip auto-fetch of models — we already know what we're using
      childEnv.OPENCODE_DISABLE_MODELS_FETCH = "true";
      break;
    default:
      // Claude Code
      childEnv.ANTHROPIC_BASE_URL = `${PROXY_URL}`;
      childEnv.ANTHROPIC_API_KEY = apiKey;
      childEnv.ANTHROPIC_MODEL = model;
      childEnv.ANTHROPIC_SMALL_FAST_MODEL = model;
      autoApproveClaudeKey(apiKey);
      break;
  }

  const displayArgs = extraArgs.map((a) =>
    apiKey && a.includes(apiKey) ? a.replaceAll(apiKey, redactKey(apiKey)) : a,
  );
  badge(
    "muted",
    `Spawning: ${t.accent(clientCmd)} ${t.muted(displayArgs.join(" "))}\n`,
  );

  const binaryPath = resolveClientBinary(clientCmd as ClientName);

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, extraArgs, {
      env: childEnv,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null)
        warn(`${clientCmd} exited with code ${code}`);
      resolve();
    });
    child.on("error", reject);
  });
}

export async function testConnectivity(
  apiKey: string,
  model: string,
  provider?: string,
): Promise<boolean> {
  const spin = createSpinner("Verifying API connection...");
  try {
    const res = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 200) {
      spin.stop({ type: "success", text: "API connected successfully" });
      return true;
    }

    const bodyText = await res.text();
    let errorObj: any = null;
    try {
      errorObj = JSON.parse(bodyText);
    } catch {}

    const isModelError =
      errorObj?.error?.type === "ModelError" ||
      errorObj?.type === "ModelError";

    const errorMsg = errorObj?.error?.message || errorObj?.message;

    if (isModelError) {
      spin.stop({
        type: "error",
        text: `Model error (HTTP ${res.status}): ${errorMsg || `Model "${model}" is not supported by upstream`}`,
      });
      if (bodyText && !errorMsg) {
        console.log(`  ${t.muted(bodyText.slice(0, 200))}\n`);
      }
      console.log(`  ${t.warning(SYM.warn)} Pick a different model with: ${t.primary("pontis models")}, then ${t.primary("pontis config set model <id>")}\n`);
      return false;
    }

    if (res.status === 401 || res.status === 403) {
      spin.stop({
        type: "error",
        text: `Authentication failed (HTTP ${res.status}) — check your API credentials`,
      });
      if (bodyText) {
        console.log(`  ${t.muted(bodyText.slice(0, 200))}\n`);
      }
      switch (provider) {
        case "opencode":
          console.log(`  ${t.warning(SYM.warn)} Configure a valid OpenCode API key with: ${t.primary("pontis auth set opencode")}\n`);
          break;
        case "cloudflare":
          console.log(`  ${t.warning(SYM.warn)} Configure Cloudflare credentials with: ${t.primary("pontis auth set cloudflare")}\n`);
          break;
        case "local":
          console.log(`  ${t.warning(SYM.warn)} Verify your local AI engine or configure with: ${t.primary("pontis auth set local")}\n`);
          break;
        default:
          console.log(`  ${t.warning(SYM.warn)} Configure your credentials with: ${t.primary("pontis auth")}\n`);
          break;
      }
      return false;
    }

    spin.stop({ type: "error", text: `API request failed (HTTP ${res.status})` });
    if (bodyText) {
      console.log(`  ${t.muted(bodyText.slice(0, 200))}\n`);
    }
    return false;
  } catch (err: any) {
    spin.stop({
      type: "error",
      text: `Could not reach API: ${err?.message || "connection failed"}`,
    });
    console.log(`  ${t.warning(SYM.warn)} Ensure the proxy upstream is reachable and credentials are valid.\n`);
    return false;
  }
}
