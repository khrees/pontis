import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { t, SYM, badge, kv, createSpinner, warn, section } from "./ui";
import { redactKey } from "../redact";
import { PROXY_URL } from "./proxy-manager";
import { PI_AGENT_DIR, PI_MODELS_FILE, OPENCODE_AUTH_FILE, OPENCODE_DATA_DIR } from "./config";
import {
  CLIENTS,
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

export function clientBinaryExists(name: ClientName): boolean {
  return isInstalled(name);
}

export async function ensureClientReady(
  name: ClientName,
  autoInstall?: boolean,
): Promise<boolean> {
  return ensureClientInstalled(name, {
    autoInstall,
    interactive: autoInstall !== false,
  });
}

const PI_PROVIDER_NAME = "pontis";

export function piBinaryExists(): boolean {
  return isInstalled("pi");
}

export async function ensurePiInstalled(): Promise<boolean> {
  return ensureClientReady("pi", true);
}

export const PI_SETTINGS_FILE = join(PI_AGENT_DIR, "settings.json");
export const PI_AUTH_FILE = join(PI_AGENT_DIR, "auth.json");

export function setupPiProvider(apiKey: string, model?: string, proxyUrl = PROXY_URL): void {
  mkdirSync(PI_AGENT_DIR, { recursive: true, mode: 0o700 });

  let existing: Record<string, unknown> = {};
  if (existsSync(PI_MODELS_FILE)) {
    try {
      existing = JSON.parse(readFileSync(PI_MODELS_FILE, "utf-8"));
    } catch {}
  }

  const selectedModel = model ?? "default-model";
  const merged = {
    ...existing,
    providers: {
      ...((existing.providers as Record<string, unknown>) || {}),
      [PI_PROVIDER_NAME]: {
        baseUrl: `${proxyUrl}/v1`,
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

export function setupOpenCodeProvider(apiKey: string, proxyUrl = PROXY_URL): void {
  mkdirSync(OPENCODE_DATA_DIR, { recursive: true, mode: 0o700 });

  let existing: Record<string, any> = {};
  if (existsSync(OPENCODE_AUTH_FILE)) {
    try {
      existing = JSON.parse(readFileSync(OPENCODE_AUTH_FILE, "utf-8"));
    } catch {}
  }

  existing[OPENCODE_PROVIDER_ID] = {
    apiKey,
    baseUrl: `${proxyUrl}/v1`,
  };

  writeFileSync(OPENCODE_AUTH_FILE, JSON.stringify(existing, null, 2), {
    mode: 0o600,
  });
}

export function cleanupOpenCodeProvider(): void {
  if (!existsSync(OPENCODE_AUTH_FILE)) return;

  try {
    const raw = readFileSync(OPENCODE_AUTH_FILE, "utf-8");
    const content = JSON.parse(raw);
    const entry = content[OPENCODE_PROVIDER_ID];

    if (entry && typeof entry.baseUrl === "string" && entry.baseUrl.includes("localhost:")) {
      delete content[OPENCODE_PROVIDER_ID];

      if (Object.keys(content).length === 0) {
        unlinkSync(OPENCODE_AUTH_FILE);
      } else {
        writeFileSync(OPENCODE_AUTH_FILE, JSON.stringify(content, null, 2), {
          mode: 0o600,
        });
      }
    }
  } catch {}
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
  } catch {}
}

const CODEX_PROVIDER_ID = "pontis";

export function setupCodexProvider(proxyUrl = PROXY_URL): void {
  const dir = join(homedir(), ".codex");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const profilePath = join(dir, `${CODEX_PROVIDER_ID}.config.toml`);
  const profileContent = `\
model_provider = "${CODEX_PROVIDER_ID}"

[model_providers.${CODEX_PROVIDER_ID}]
name = "Pontis Proxy"
base_url = "${proxyUrl}/v1"
wire_api = "responses"
`;
  writeFileSync(profilePath, profileContent, { mode: 0o600 });
}

/**
 * Remove the Pontis profile config from ~/.codex/.
 */
export function cleanupCodexProvider(): void {
  // Safe no-op to allow multiple concurrent Codex instances without file deletion races
}

export function launchClient(
  clientCmd: string,
  model: string,
  apiKey: string,
  extraArgs: string[],
  proxyUrl = PROXY_URL,
): Promise<void> {
  // Section header
  const CLIENT_DISPLAY_NAMES: Record<string, string> = {
    codex: "Codex",
    server: "Server Mode",
    pi: "Pi",
    opencode: "OpenCode",
    claude: "Claude Code",
    hermes: "Hermes Agent",
  };
  const clientDisplayName = CLIENT_DISPLAY_NAMES[clientCmd] || "Claude Code";
  section("Launching " + clientDisplayName);

  kv("Proxy", t.secondary(proxyUrl));
  kv("Model", t.primary(model));
  if (extraArgs.length > 0) kv("Args", t.muted(extraArgs.join(" ")));

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
      childEnv.OPENAI_BASE_URL = `${proxyUrl}/v1`;
      childEnv.OPENAI_API_KEY = apiKey;
      childEnv.PONTIS_API_KEY = apiKey;
      if (!extraArgs.includes("--profile") && !extraArgs.includes("-p")) {
        extraArgs = ["--profile", CODEX_PROVIDER_ID, ...extraArgs];
      }
      if (!extraArgs.includes("--model") && !extraArgs.includes("-m")) {
        extraArgs = extraArgs.concat("--model", model);
      }
      break;
    case "hermes":
      // Hermes Agent routes through OpenAI-compatible API
      childEnv.OPENAI_BASE_URL = `${proxyUrl}/v1`;
      childEnv.OPENAI_API_KEY = apiKey;
      childEnv.HERMES_API_BASE = `${proxyUrl}/v1`;
      childEnv.HERMES_MODEL = model;
      childEnv.PONTIS_API_KEY = apiKey;
      if (!extraArgs.includes("--model") && !extraArgs.includes("-m")) {
        extraArgs = ["--model", model, ...extraArgs];
      }
      break;
    case "pi":
      // Pass the key via environment only. Do NOT add it as a --api-key argv:
      // command-line args are visible to other processes via `ps`. Pi resolves
      // the key from OPENAI_API_KEY / PONTIS_API_KEY.
      childEnv.PONTIS_API_KEY = apiKey;
      childEnv.OPENAI_API_KEY = apiKey;
      extraArgs = [
        "--provider",
        PI_PROVIDER_NAME,
        "--model",
        model,
        ...extraArgs,
      ];
      break;
    case "opencode":
      if (!extraArgs.includes("--model")) {
        extraArgs = ["--model", `openai/${model}`, ...extraArgs];
      }
      childEnv.OPENCODE_DISABLE_MODELS_FETCH = "true";
      break;
    default:
      // Claude Code
      childEnv.ANTHROPIC_BASE_URL = `${proxyUrl}`;
      childEnv.ANTHROPIC_API_KEY = apiKey;
      childEnv.ANTHROPIC_MODEL = model;
      childEnv.ANTHROPIC_SMALL_FAST_MODEL = model;
      autoApproveClaudeKey(apiKey);
      break;
  }

  // Ensure common tool directories are in PATH for spawned processes
  const home = homedir();
  const additionalPaths = [
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((p) => existsSync(p));

  if (additionalPaths.length > 0) {
    const currentPath = childEnv.PATH || process.env.PATH || "";
    childEnv.PATH = `${additionalPaths.join(":")}:${currentPath}`;
  }

  const binaryPath = resolveClientBinary(clientCmd as ClientName);
  const binaryName = CLIENTS[clientCmd as ClientName]?.binary || clientCmd;

  const displayArgs = extraArgs.map((a) =>
    apiKey && a.includes(apiKey) ? a.replaceAll(apiKey, redactKey(apiKey)) : a,
  );
  badge(
    "muted",
    `Spawning: ${t.accent(binaryName)} ${t.muted(displayArgs.join(" "))}`,
  );

  const restoreTty = () => {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      try { process.stdin.setRawMode(false); } catch {}
    }
    try { process.stdin.resume(); } catch {}
    process.stdout.write("\x1B[?25h");
  };

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, extraArgs, {
      env: childEnv,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      restoreTty();
      if (code !== 0 && code !== null)
        warn(`${clientCmd} exited with code ${code}`);
      resolve();
    });
    child.on("error", (err) => {
      restoreTty();
      reject(err);
    });
  });
}

export async function testConnectivity(
  apiKey: string,
  model: string,
  provider?: string,
  proxyUrl = PROXY_URL,
): Promise<boolean> {
  const spin = createSpinner("Verifying API connection...");
  try {
    const res = await fetch(`${proxyUrl}/v1/messages`, {
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

    const errorMsg = errorObj?.error?.message || errorObj?.message;
    const lowerMsg = typeof errorMsg === "string" ? errorMsg.toLowerCase() : "";

    const isModelError =
      errorObj?.error?.type === "ModelError" ||
      errorObj?.type === "ModelError" ||
      lowerMsg.includes("model") ||
      lowerMsg.includes("disabled");

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
        case "google":
          console.log(`  ${t.warning(SYM.warn)} Configure Google credentials with: ${t.primary("pontis auth set google")}\n`);
          break;
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
