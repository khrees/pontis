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
    if (!res.ok) return [];
    const json: any = await res.json();
    if (!json || !Array.isArray(json.data)) return [];
    return json.data.map((m: any) => m.id);
  } catch {
    return [];
  }
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
  const models = await fetchLocalModels(upstreamUrl, apiKey);
  spin.stop(
    models.length > 0
      ? {
          type: "success",
          text: `Found ${models.length} model${models.length === 1 ? "" : "s"}`,
        }
      : { type: "warning", text: "No models returned from upstream" },
  );

  let model: string;
  if (models.length === 0) {
    model = await input("Model name (e.g. llama3, qwen2.5-coder)", "llama3");
    if (!model) model = "llama3";
  } else {
    const result = await select("Pick a model", models, { defaultIndex: 0 });
    if (result.index === -1) {
      model = await input("Enter model ID", models[0]);
      if (!model) model = models[0];
    } else {
      model = result.value;
    }
  }

  savePreferences({ defaultModel: model, defaultProvider: "local" });

  return { model, upstreamUrl, upstreamFormat: "openai", apiKey };
}
