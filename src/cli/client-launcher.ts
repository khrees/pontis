import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { t, SYM, badge, kv, confirm, createSpinner, warn } from "./ui";
import { PROXY_URL } from "./proxy-manager";
import { PI_AGENT_DIR, PI_MODELS_FILE, OPENCODE_AUTH_FILE, OPENCODE_DATA_DIR } from "./config";
import {
  isInstalled,
  ensureClientInstalled,
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

/**
 * Resolve a client binary path. Checks PATH first, then
 * falls back to ~/.pontis/clients/<name>/bin/<binary> for
 * Pontis-managed installations.
 */
function resolveClientBinary(name: ClientName): string {
  // If on PATH, use it (honor existing installations)
  try {
    const resolved = execSync(`which "${name}" 2>/dev/null || command -v "${name}" 2>/dev/null`)
      .toString()
      .trim();
    if (resolved) return resolved;
  } catch {
    // not found
  }
  // Fallback: Pontis-managed install under ~/.pontis/clients
  const local = join(homedir(), ".pontis", "clients", name, "bin", name);
  if (existsSync(local)) return local;
  // npm --prefix layout: node_modules/.bin/
  const npmBin = join(homedir(), ".pontis", "clients", name, "node_modules", ".bin", name);
  if (existsSync(npmBin)) return npmBin;
  // Last resort: trust the shell to find it
  return name;
}

export function launchClient(
  clientCmd: string,
  model: string,
  apiKey: string,
  extraArgs: string[],
): Promise<void> {
  // Section header
  const clientDisplayName =
    clientCmd === "codex"
      ? "Codex"
      : clientCmd === "server"
        ? "Server Mode"
        : clientCmd === "pi"
          ? "Pi"
          : clientCmd === "opencode"
            ? "OpenCode"
            : "Claude Code";
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

  if (clientCmd === "codex") {
    childEnv.OPENAI_BASE_URL = `${PROXY_URL}/v1`;
    childEnv.OPENAI_API_KEY = apiKey;
    if (!extraArgs.includes("--model"))
      extraArgs = ["--model", model, ...extraArgs];
  } else if (clientCmd === "pi") {
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
  } else if (clientCmd === "opencode") {
    // OpenCode uses provider/model notation and reads credentials from
    // ~/.local/share/opencode/auth.json (not env vars).
    // The auth file was written by setupOpenCodeProvider() before launch.
    // We pass the model as openai/<model> since Pontis speaks OpenAI format.
    if (!extraArgs.includes("--model")) {
      extraArgs = ["--model", `openai/${model}`, ...extraArgs];
    }
    // Skip auto-fetch of models — we already know what we're using
    childEnv.OPENCODE_DISABLE_MODELS_FETCH = "true";
  } else {
    // Claude Code
    childEnv.ANTHROPIC_BASE_URL = `${PROXY_URL}/zen`;
    childEnv.ANTHROPIC_API_KEY = apiKey;
    childEnv.ANTHROPIC_MODEL = model;
    childEnv.ANTHROPIC_SMALL_FAST_MODEL = model;
    autoApproveClaudeKey(apiKey);
  }

  const displayArgs = extraArgs.map((a, i, arr) =>
    a === "--api-key"
      ? "--api-key <redacted>"
      : i > 0 && arr[i - 1] === "--api-key"
        ? "<redacted>"
        : a,
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
): Promise<boolean> {
  const spin = createSpinner("Verifying API connection...");
  try {
    const res = await fetch(`${PROXY_URL}/zen/v1/messages`, {
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
    if (res.status === 401) {
      spin.stop({
        type: "error",
        text: "API returned 401 — check your API key",
      });
      const body = await res.text();
      console.log(`  ${t.muted(body.slice(0, 200))}\n`);
      return await confirm("Continue anyway?", false);
    }
    spin.stop({ type: "warning", text: `HTTP ${res.status} — continuing` });
    return true;
  } catch {
    spin.stop({
      type: "warning",
      text: "Could not reach API — continuing anyway",
    });
    return true;
  }
}
