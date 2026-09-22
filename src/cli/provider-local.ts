import { select, input, createSpinner, badge, t } from "./ui";
import { getLocalApiKey } from "./config";
import { getPreferences, savePreferences } from "./preferences";

export const LOCAL_ENGINES = [
  { name: "Ollama", url: "http://localhost:11434/v1", checkUrl: "http://localhost:11434/api/version" },
  { name: "LM Studio", url: "http://localhost:1234/v1", checkUrl: "http://localhost:1234/v1/models" },
  { name: "Llama.cpp", url: "http://localhost:8080/v1", checkUrl: "http://localhost:8080/health" },
];

/**
 * Probes common local AI endpoints to detect if any are currently running.
 */
export async function detectRunningLocalEngine(): Promise<{ name: string; url: string } | null> {
  for (const engine of LOCAL_ENGINES) {
    try {
      const res = await fetch(engine.checkUrl, { signal: AbortSignal.timeout(600) });
      if (res.ok) {
        return { name: engine.name, url: engine.url };
      }
    } catch {}
  }
  return null;
}

export async function selectLocalEngineInteractive(): Promise<string> {
  const prefs = getPreferences();
  const detected = await detectRunningLocalEngine();

  const options = LOCAL_ENGINES.map((e) => {
    const isDetected = detected && detected.name === e.name;
    const detectedTag = isDetected ? ` ${t.success("(Running)")}` : "";
    return `${t.primary(e.name.padEnd(12))}  ${t.muted(e.url)}${detectedTag}`;
  });

  const defaultIdx = detected
    ? LOCAL_ENGINES.findIndex((e) => e.name === detected.name)
    : prefs.localEndpoint
      ? LOCAL_ENGINES.findIndex((e) => e.url === prefs.localEndpoint)
      : 0;

  const result = await select("Choose local model engine", options, {
    allowCustom: true,
    defaultIndex: defaultIdx >= 0 ? defaultIdx : 0,
    customLabel: "Custom URL (enter endpoint manually)",
  });

  if (result.index === -1) {
    const url = await input("Enter custom endpoint URL", prefs.localEndpoint || "http://localhost:11434/v1");
    if (!url) {
      badge("warning", "No URL entered — defaulting to Ollama (http://localhost:11434/v1)");
      return LOCAL_ENGINES[0].url;
    }
    return url.trim();
  }

  return LOCAL_ENGINES[result.index].url;
}

export const KNOWN_OLLAMA_MODELS: readonly string[] = [
  "deepseek-v4.1-flash",
  "deepseek-v4-flash:0731",
  "deepseek-v4-pro:0813",
  "deepseek-r1:32b",
  "deepseek-r1:8b",
  "llama3.3:70b",
  "llama3.2:3b",
  "llama3.1:8b",
  "qwen3.5:latest",
  "qwen3:8b",
  "qwen3-coder-next:cloud",
  "qwen2.5-coder:32b",
  "qwen2.5-coder:7b",
  "gemma4:31b",
  "gemma3:12b",
  "gemma2:9b",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.5:cloud",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "minimax-m3",
  "minimax-m2.7",
  "gpt-oss:120b",
  "gpt-oss:20b",
  "mistral-large-3:675b",
  "mistral:7b",
  "phi4:14b",
  "nemotron-3-ultra",
  "granite3-dense:8b",
];

export async function fetchLocalModels(
  upstreamUrl: string,
  apiKey: string,
): Promise<string[]> {
  try {
    const res = await fetch(`${upstreamUrl}/models`, {
      headers:
        apiKey !== "local-model-dummy-api-key-value-32-chars-long"
          ? { Authorization: `Bearer ${apiKey}` }
          : {},
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const json: any = await res.json();
      if (json && Array.isArray(json.data) && json.data.length > 0) {
        return json.data.map((m: any) => m.id);
      }
    }
  } catch {}

  // Fallback to Ollama native /api/tags if /v1/models returned nothing
  try {
    const baseUrl = upstreamUrl.replace(/\/v1\/?$/, "");
    const tagsRes = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (tagsRes.ok) {
      const tagsJson: any = await tagsRes.json();
      if (tagsJson && Array.isArray(tagsJson.models)) {
        return tagsJson.models.map((m: any) => m.name || m.model).filter(Boolean);
      }
    }
  } catch {}

  return [];
}

/**
 * Fetch available models from Ollama's public library / registry.
 */
export async function fetchOllamaRegistryModels(): Promise<string[]> {
  try {
    const res = await fetch("https://ollama.com/api/tags", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const json: any = await res.json();
    if (!json || !Array.isArray(json.models)) return [];
    return json.models.map((m: any) => m.name || m.model).filter(Boolean);
  } catch {
    return [];
  }
}

function extractVersion(name: string): number {
  const match = name.match(/(\d+\.\d+)/);
  if (match) return parseFloat(match[1]);
  const intMatch = name.match(/(\d+)/);
  return intMatch ? parseInt(intMatch[1], 10) : 0;
}

function extractParamSize(name: string): number {
  const match = name.toLowerCase().match(/(\d+)b/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Sort local models descending by version and parameter size within model families.
 */
export function sortLocalModels(models: string[]): string[] {
  return [...models].sort((a, b) => {
    const baseA = a.toLowerCase().split(/[:\/-]/)[0].replace(/[0-9.]/g, "");
    const baseB = b.toLowerCase().split(/[:\/-]/)[0].replace(/[0-9.]/g, "");
    if (baseA !== baseB) {
      return baseA.localeCompare(baseB);
    }
    const vA = extractVersion(a);
    const vB = extractVersion(b);
    if (vA !== vB) return vB - vA;
    const pA = extractParamSize(a);
    const pB = extractParamSize(b);
    if (pA !== pB) return pB - pA;
    return a.localeCompare(b);
  });
}

export interface LocalModelGroups {
  free: string[];
  frontier: string[];
  chinese: string[];
  others: string[];
  all: string[];
}

/**
 * Categorizes local / Ollama models into four uniform categories:
 * 1. Free: Locally-stored open weights (zero token charges, offline execution)
 * 2. Frontier: Flagship open-weight & reasoning architectures (Llama 3.3+, DeepSeek-R1/V4, Qwen 3.5+, Gemma 4, GLM-5, Kimi K2.5+, etc.)
 * 3. Chinese: DeepSeek, Qwen, Kimi, GLM, MiniMax, Hunyuan, MiniCPM, Yi, Baichuan
 * 4. Others: Meta Llama, Google Gemma, Mistral, Microsoft Phi, NVIDIA Nemotron, IBM Granite
 */
export function categorizeLocalModels(models: string[]): LocalModelGroups {
  const free: string[] = [];
  const frontier: string[] = [];
  const chinese: string[] = [];
  const others: string[] = [];

  for (const m of models) {
    const lower = m.toLowerCase();

    // 1. Free: Locally stored & executed models without cloud proxy metering
    const isCloudRemote =
      lower.endsWith(":cloud") ||
      lower.endsWith("-cloud") ||
      lower.includes(":cloud-") ||
      lower.includes("-cloud-") ||
      lower.includes("/cloud");
    if (!isCloudRemote) {
      free.push(m);
    }

    // 2. Frontier: High-capability flagship reasoning/coding models and large parameter models
    const isFrontier =
      lower.includes("r1") ||
      lower.includes("v4") ||
      lower.includes("v3") ||
      lower.includes("3.5") ||
      lower.includes("3.6") ||
      lower.includes("3.7") ||
      lower.includes("3.8") ||
      lower.includes("next") ||
      lower.includes("k3") ||
      lower.includes("k2.7") ||
      lower.includes("k2.6") ||
      lower.includes("k2.5") ||
      lower.includes("m3") ||
      lower.includes("m2.7") ||
      lower.includes("5.3") ||
      lower.includes("5.2") ||
      lower.includes("5.1") ||
      lower.includes("gemma4") ||
      lower.includes("llama3.3") ||
      lower.includes("llama4") ||
      lower.includes("gpt-oss") ||
      lower.includes("large") ||
      lower.includes("ultra") ||
      lower.includes("super") ||
      lower.includes("70b") ||
      lower.includes("72b") ||
      lower.includes("120b") ||
      lower.includes("397b") ||
      lower.includes("675b");
    if (isFrontier) {
      frontier.push(m);
    }

    // 3. Chinese: DeepSeek, Qwen, Kimi, GLM, MiniMax, Hunyuan, MiniCPM, Yi, Baichuan
    const isChinese =
      lower.includes("qwen") ||
      lower.includes("qwq") ||
      lower.includes("deepseek") ||
      lower.includes("kimi") ||
      lower.includes("glm") ||
      lower.includes("minimax") ||
      lower.includes("hy3") ||
      lower.includes("hy4") ||
      lower.includes("minicpm") ||
      lower.includes("yi") ||
      lower.includes("baichuan") ||
      lower.includes("chatglm");
    if (isChinese) {
      chinese.push(m);
    } else {
      // 4. Others: Meta, Google, Mistral, Microsoft, NVIDIA, IBM
      others.push(m);
    }
  }

  // If all detected models were cloud-proxied or none matched strict local filter,
  // ensure free includes all open-weight models
  if (free.length === 0 && models.length > 0) {
    free.push(...models);
  }

  return {
    free: sortLocalModels(free),
    frontier: sortLocalModels(frontier),
    chinese: sortLocalModels(chinese),
    others: sortLocalModels(others),
    all: sortLocalModels(models),
  };
}

export async function setupLocalInteractive(): Promise<{
  model: string;
  upstreamUrl: string;
  upstreamFormat: string;
  apiKey: string;
}> {
  const upstreamUrl = await selectLocalEngineInteractive();
  savePreferences({ localEndpoint: upstreamUrl });
  const apiKey = getLocalApiKey();

  if (!process.env.PONTIS_UPSTREAM_URL)
    process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  if (!process.env.PONTIS_UPSTREAM_FORMAT)
    process.env.PONTIS_UPSTREAM_FORMAT = "openai";

  const spin = createSpinner("Scanning local models...");
  const rawModels = await fetchLocalModels(upstreamUrl, apiKey);
  const models = rawModels.length > 0 ? rawModels : (await fetchOllamaRegistryModels());
  const effectiveModels = models.length > 0 ? models : [...KNOWN_OLLAMA_MODELS];
  const groups = categorizeLocalModels(effectiveModels);

  spin.stop(
    rawModels.length > 0
      ? {
          type: "success",
          text: `Found ${rawModels.length} local model${rawModels.length === 1 ? "" : "s"}`,
        }
      : models.length > 0
        ? {
            type: "success",
            text: `No local models installed — fetched ${models.length} from Ollama registry`,
          }
        : { type: "warning", text: "No models returned from upstream" },
  );

  let model: string;
  if (effectiveModels.length === 0) {
    model = await input("Model name (e.g. llama3, qwen2.5-coder)", "llama3");
    if (!model) model = "llama3";
  } else {
    // Present the four categories
    const categories = [
      { name: "Free", count: groups.free.length, hint: "Locally cached & open weights (0 token cost)", list: groups.free },
      { name: "Frontier", count: groups.frontier.length, hint: "Flagship reasoning & high-parameter", list: groups.frontier },
      { name: "Chinese", count: groups.chinese.length, hint: "Qwen, DeepSeek, Kimi, MiniMax, GLM", list: groups.chinese },
      { name: "Others", count: groups.others.length, hint: "Meta Llama, Google Gemma, Mistral, Microsoft", list: groups.others },
    ].filter((c) => c.count > 0);

    const catChoices = categories.map((c, i) =>
      `${t.bold(String(i + 1).padStart(2))} ${t.primary(c.name.padEnd(12))} ${t.muted(`${c.count} model${c.count === 1 ? "" : "s"}`)} · ${t.dim(c.hint)}`
    );

    const catResult = await select("Pick local model category", catChoices, {
      defaultIndex: 0,
      allowCustom: true,
      customLabel: "Custom model ID (enter manually)",
    });

    if (catResult.index === -1) {
      model = await input("Enter model ID", effectiveModels[0]);
      if (!model) model = effectiveModels[0];
    } else {
      const selectedCategory = categories[catResult.index];
      const modelChoices = selectedCategory.list.map((m) => {
        const lower = m.toLowerCase();
        const isCloud =
          lower.endsWith(":cloud") ||
          lower.endsWith("-cloud") ||
          lower.includes(":cloud-") ||
          lower.includes("-cloud-") ||
          lower.includes("/cloud");
        const tag = isCloud ? t.muted(" [Cloud]") : t.secondary(" [Local/Free]");
        return `${m}${tag}`;
      });

      const modelResult = await select(
        `Pick a ${selectedCategory.name} model`,
        modelChoices,
        {
          defaultIndex: 0,
          allowCustom: true,
          customLabel: "Custom model ID (enter manually)",
        }
      );

      if (modelResult.index === -1) {
        model = await input("Enter model ID", selectedCategory.list[0]);
        if (!model) model = selectedCategory.list[0];
      } else {
        model = selectedCategory.list[modelResult.index];
      }
    }
  }

  savePreferences({ defaultModel: model, defaultProvider: "local" });

  return { model, upstreamUrl, upstreamFormat: "openai", apiKey };
}
