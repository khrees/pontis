import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { select, input, createSpinner, badge, section, splash, t } from "./ui";
import { CACHE_FILE, getOpenCodeApiKey } from "./config";
import { storeOpenCodeApiKey } from "../secure-storage";
import { savePreferences } from "./preferences";
import { isFreeOpenCodeModel } from "../opencode-models";

// Free-tier models that are listed upstream but known to be broken/offline.
const EXCLUDED_FREE_MODELS = new Set(["minimax-m3-free"]);

export async function getOpenCodeApiKeyInteractive(): Promise<string> {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;

  // Check secure storage
  const secureKey = getOpenCodeApiKey();
  if (secureKey) return secureKey;

  section("OpenCode API Key Setup");
  console.log(
    `  Get your free API key at ${t.secondary("https://opencode.ai/auth")} → Zen → API Keys\n`,
  );
  const key = await input("Paste your OpenCode API key", undefined, true);
  if (!key || !key.trim()) {
    badge("error", "API key is required to use OpenCode cloud models.");
    process.exit(1);
  }

  const cleanKey = key.trim();
  storeOpenCodeApiKey(cleanKey);
  badge("success", "API key saved securely");
  return cleanKey;
}

export async function checkModelOnline(
  model: string,
  apiKey: string,
): Promise<boolean> {
  try {
    const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 200) {
      const data: any = await res.json();
      return !!(data && !data.error);
    }
  } catch {}
  return false;
}

export async function fetchWorkingOpenCodeModels(apiKey: string): Promise<string[]> {
  if (existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      if (
        Array.isArray(cache.models) &&
        typeof cache.timestamp === "number" &&
        Date.now() - cache.timestamp < 86400000
      ) {
        return cache.models;
      }
    } catch {}
  }
  try {
    const res = await fetch("https://opencode.ai/zen/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    if (!json || !Array.isArray(json.data)) return [];
    const candidates = json.data
      .map((m: any) => m.id)
      .filter(
        (id: string) => isFreeOpenCodeModel(id) && !EXCLUDED_FREE_MODELS.has(id),
      );
    const results = await Promise.all(
      candidates.map((m: string) => checkModelOnline(m, apiKey)),
    );
    const working = results.filter(Boolean).map((_, i) => candidates[i]);
    if (working.length > 0) {
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(
        CACHE_FILE,
        JSON.stringify({ timestamp: Date.now(), models: working }),
        { encoding: "utf-8", mode: 0o600 },
      );
    }
    return working;
  } catch {
    return [];
  }
}

export async function setupOpenCodeInteractive(): Promise<{
  model: string;
  apiKey: string;
}> {
  const apiKey = await getOpenCodeApiKeyInteractive();

  const spin = createSpinner("Checking available models...");
  const models = await fetchWorkingOpenCodeModels(apiKey);
  spin.stop(
    models.length > 0
      ? {
          type: "success",
          text: `${models.length} model${models.length === 1 ? "" : "s"} available`,
        }
      : { type: "warning", text: "No models returned from OpenCode API" },
  );

  let model: string;
  if (models.length === 0) {
    model = await input("Enter model ID (e.g. mimo-v2.5-free, qwen3.6-plus)", "mimo-v2.5-free");
    if (!model) model = "mimo-v2.5-free";
  } else {
    const choices = [...models, "✏️ Enter Custom Model ID"];
    const result = await select("Pick a model", choices, { defaultIndex: 0 });
    if (result.index === -1 || result.index === choices.length - 1) {
      model = await input("Enter model ID", models[0]);
      if (!model) model = models[0];
    } else {
      model = result.value;
    }
  }

  savePreferences({ defaultModel: model, defaultProvider: "opencode" });

  return { model, apiKey };
}

export async function cmdUpdateKey(keyArg?: string) {
  splash();
  section("Update OpenCode API Key");
  let apiKey = keyArg;
  if (!apiKey) {
    console.log(
      `  Get your key at ${t.secondary("https://opencode.ai/auth")} → Zen → API Keys\n`,
    );
    apiKey = await input("Paste your OpenCode API key", undefined, true);
  }
  if (!apiKey || !apiKey.trim()) {
    badge("error", "API key is required.");
    process.exit(1);
  }
  const cleanKey = apiKey.trim();
  storeOpenCodeApiKey(cleanKey);
  badge("success", "OpenCode API key saved securely");
}
