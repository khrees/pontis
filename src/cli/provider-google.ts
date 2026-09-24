import { select, input, inputRequired, createSpinner, badge, t } from "./ui";
import { getGoogleApiKey, getGoogleAuthToken, GOOGLE_DEFAULT_UPSTREAM } from "./config";
import { storeGoogleApiKey } from "../secure-storage";
import { getPreferences, savePreferences } from "./preferences";

export const GOOGLE_DEFAULT_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-thinking-exp-01-21",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "gemma-2-27b-it",
  "gemma-2-9b-it",
];

/**
 * Interactive prompt for Google AI Studio API Key.
 */
export async function getGoogleApiKeyInteractive(): Promise<string> {
  const existing = getGoogleApiKey();
  if (existing) return existing;

  console.log(`  1. Open ${t.secondary("https://aistudio.google.com/apikey")} in your browser`);
  console.log(`  2. Click ${t.bold('"Create API key"')} (100% Free with standard Google account)`);
  console.log(`  3. Paste the key below:`);

  const key = await input("Google AI Studio API Key", undefined, true);
  if (!key || !key.trim()) {
    badge("error", "API key is required.");
    process.exit(1);
  }

  const cleanKey = key.trim();
  storeGoogleApiKey(cleanKey);
  badge("success", "Google API key saved securely");
  return cleanKey;
}

/**
 * Fetch available Gemini / Google models from Google AI endpoint.
 */
export async function fetchGoogleModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return GOOGLE_DEFAULT_MODELS;

    const json: any = await res.json();
    if (!json || !Array.isArray(json.models)) return GOOGLE_DEFAULT_MODELS;

    const discovered = json.models
      .map((m: any) => m.name ? m.name.replace(/^models\//, "") : "")
      .filter((name: string) => name && (name.startsWith("gemini-") || name.startsWith("gemma-")));

    return discovered.length > 0 ? discovered : GOOGLE_DEFAULT_MODELS;
  } catch {
    return GOOGLE_DEFAULT_MODELS;
  }
}

/**
 * Interactive setup flow for Google provider.
 */
export async function setupGoogleInteractive(): Promise<{
  model: string;
  apiKey: string;
  upstreamUrl: string;
}> {
  const existingKey = getGoogleAuthToken();
  const apiKey = existingKey || (await getGoogleApiKeyInteractive());

  const upstreamUrl = GOOGLE_DEFAULT_UPSTREAM;
  if (!process.env.PONTIS_UPSTREAM_URL) {
    process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  }
  if (!process.env.PONTIS_UPSTREAM_FORMAT) {
    process.env.PONTIS_UPSTREAM_FORMAT = "openai";
  }

  const spin = createSpinner("Fetching available Google Gemini models...");
  const models = await fetchGoogleModels(apiKey);
  spin.stop(
    models.length > 0
      ? { type: "success", text: `Found ${models.length} Google model${models.length === 1 ? "" : "s"}` }
      : { type: "warning", text: "Using default Gemini model list" },
  );

  let model: string;
  if (models.length === 0) {
    model = await input("Enter model ID (e.g. gemini-2.5-flash)", "gemini-2.5-flash");
    if (!model) model = "gemini-2.5-flash";
  } else {
    const prefs = getPreferences();
    const activeModel = prefs.providerModels?.google || prefs.defaultModel;
    const defaultIdx = activeModel && models.indexOf(activeModel) >= 0 ? models.indexOf(activeModel) : 0;
    const result = await select("Pick a Google model", models, {
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

  savePreferences({ defaultModel: model, defaultProvider: "google" });

  return { model, apiKey, upstreamUrl };
}
