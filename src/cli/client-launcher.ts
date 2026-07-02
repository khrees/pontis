import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { t, SYM, badge, kv, confirm, createSpinner, warn } from "./ui";
import { PROXY_URL } from "./proxy-manager";
import { PI_AGENT_DIR, PI_MODELS_FILE } from "./config";

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
//  Pi coding agent helpers
// ──────────────────────────────────────────────

const PI_PROVIDER_NAME = "pontis";

/** Check if the `pi` binary is on PATH. */
export function piBinaryExists(): boolean {
  try {
    execSync("which pi 2>/dev/null || command -v pi 2>/dev/null", {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Prompt the user to install Pi if missing. Returns true once installed. */
export async function ensurePiInstalled(): Promise<boolean> {
  // Pi requires Node >= 22.19.0
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    badge(
      "warning",
      `Pi requires Node >= 22.19.0 (current: ${process.versions.node})`,
    );
    return false;
  }

  if (piBinaryExists()) return true;

  badge("warning", "Pi coding agent is not installed");
  const ok = await confirm(
    "Install Pi coding agent? (npm install -g @earendil-works/pi-coding-agent)",
    true,
  );
  if (!ok) {
    badge(
      "muted",
      "Install manually: npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
    );
    return false;
  }

  const spin = createSpinner("Installing Pi coding agent...");
  try {
    execSync("npm install -g --ignore-scripts @earendil-works/pi-coding-agent", {
      stdio: "pipe",
      timeout: 120_000,
    });
    spin.stop({ type: "success", text: "Pi coding agent installed" });
    return piBinaryExists();
  } catch {
    spin.stop({ type: "error", text: "Failed to install Pi coding agent" });
    badge(
      "muted",
      "Install manually: npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
    );
    return false;
  }
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

  // The model the user selected — Pi needs at least one model definition
  // for the custom provider so the model resolver registers it in its
  // provider map. Once the provider is known, buildFallbackModel() can
  // synthesise any additional model IDs on the fly.
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
  } else {
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

  return new Promise((resolve, reject) => {
    const child = spawn(clientCmd, extraArgs, {
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
