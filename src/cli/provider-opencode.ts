import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { select, input, inputRequired, createSpinner, badge, section, splash, t } from "./ui";
import { CACHE_FILE, getOpenCodeApiKey } from "./config";
import { storeOpenCodeApiKey } from "../secure-storage";
import { getPreferences, savePreferences } from "./preferences";
import { isFreeOpenCodeModel, registerFreeOpenCodeModels } from "../opencode-models";

// Free-tier models that are listed upstream but known to be broken/offline.
const EXCLUDED_FREE_MODELS = new Set(["minimax-m3-free"]);

export async function getOpenCodeApiKeyInteractive(): Promise<string> {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;

  // Check secure storage
  const secureKey = getOpenCodeApiKey();
  if (secureKey) return secureKey;

  console.log(
    `  Get your free API key at ${t.secondary("https://opencode.ai/auth")} → Zen → API Keys`,
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
  baseUrl = "https://opencode.ai/zen/v1",
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
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

export async function fetchWorkingOpenCodeModels(
  apiKey: string,
  forceRefresh = false,
): Promise<string[]> {
  if (!forceRefresh && existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      if (
        Array.isArray(cache.models) &&
        typeof cache.timestamp === "number" &&
        Date.now() - cache.timestamp < 300000
      ) {
        if (Array.isArray(cache.freeModels)) {
          registerFreeOpenCodeModels(cache.freeModels);
        } else {
          registerFreeOpenCodeModels(cache.models.filter((m: string) => isFreeOpenCodeModel(m)));
        }
        return cache.models;
      }
    } catch {}
  }

  // 1. Fetch models from Zen endpoint
  const fetchZen = async (): Promise<string[]> => {
    try {
      const res = await fetch("https://opencode.ai/zen/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return [];
      const json: any = await res.json();
      if (!json || !Array.isArray(json.data)) return [];

      return json.data
        .map((m: any) => (typeof m === "string" ? m : m?.id))
        .filter((id: any) => id && typeof id === "string" && !EXCLUDED_FREE_MODELS.has(id));
    } catch {
      return [];
    }
  };

  // 2. Fetch paid models from Go endpoint
  const fetchGo = async (): Promise<string[]> => {
    try {
      const res = await fetch("https://opencode.ai/zen/go/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return [];
      const json: any = await res.json();
      if (!json || !Array.isArray(json.data)) return [];

      return json.data
        .map((m: any) => (typeof m === "string" ? m : m?.id))
        .filter((id: any) => id && typeof id === "string" && !EXCLUDED_FREE_MODELS.has(id));
    } catch {
      return [];
    }
  };

  const [zenList, goList] = await Promise.all([fetchZen(), fetchGo()]);

  // Identify free models vs paid models
  const freeList = zenList.filter((m) => isFreeOpenCodeModel(m));
  if (freeList.length > 0) {
    registerFreeOpenCodeModels(freeList);
  }

  // Combined unique list: free models first, then paid Go models
  const combined = Array.from(new Set([...freeList, ...goList, ...zenList]));

  if (combined.length > 0) {
    try {
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(
        CACHE_FILE,
        JSON.stringify({
          timestamp: Date.now(),
          models: combined,
          freeModels: freeList,
          paidModels: goList.filter((m) => !freeList.includes(m)),
        }),
        { encoding: "utf-8", mode: 0o600 },
      );
    } catch {}
  }

  return combined;
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
    const prefs = getPreferences();
    const activeModel = prefs.providerModels?.opencode || prefs.defaultModel;
    const defaultIdx = activeModel && models.indexOf(activeModel) >= 0 ? models.indexOf(activeModel) : 0;
    const result = await select("Pick a model", models, {
      defaultIndex: defaultIdx,
      customLabel: "Custom model ID (enter manually)",
    });
    if (result.index === -1) {
      // Custom entry: don't silently fall back to the list item they declined.
      model = await inputRequired("Enter model ID");
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
      `  Get your key at ${t.secondary("https://opencode.ai/auth")} → Zen → API Keys`,
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
