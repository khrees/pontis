import { select, input, createSpinner, badge } from "./ui";
import { getLocalApiKey } from "./config";

export const LOCAL_ENGINES = [
  { name: "Ollama", url: "http://localhost:11434/v1" },
  { name: "LM Studio", url: "http://localhost:1234/v1" },
  { name: "Llama.cpp", url: "http://localhost:8080/v1" },
  { name: "Custom URL", url: "" },
];

export async function selectLocalEngineInteractive(): Promise<string> {
  // Use select to pick local engine dynamically
  const engineNames = LOCAL_ENGINES.map(e => `${e.name} ${e.url ? `(${e.url})` : ""}`);
  const result = await select("Choose local model engine", engineNames);
  if (result.index === -1 || result.index === 3) {
    const url = await input("Enter custom endpoint URL");
    if (!url) {
      badge("error", "URL required.");
      return LOCAL_ENGINES[0].url;
    }
    return url;
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
      signal: AbortSignal.timeout(5000),
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
    console.log(
      `\n  ⚠  Could not auto-detect. Enter a model name manually.\n`,
    );
    model = await input("Model name", "llama3");
    if (!model) model = "llama3";
  } else {
    const result = await select("Pick a model", models);
    if (result.index === -1) {
      model = await input("Enter model ID");
      if (!model) model = models[0];
    } else {
      model = result.value;
    }
  }

  return { model, upstreamUrl, upstreamFormat: "openai", apiKey };
}
