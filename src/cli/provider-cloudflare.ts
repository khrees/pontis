import { writeFileSync } from "node:fs";
import { select, input, confirm, createSpinner, badge, section, error } from "./ui";
import {
  CLOUDFLARE_CONFIG_FILE,
  CLOUDFLARE_FALLBACK_MODELS,
  CLOUDFLARE_CATEGORIES,
  getCloudflareConfigSaved,
} from "./config";

export async function getCloudflareConfigInteractive(): Promise<{
  apiToken: string;
  accountId: string;
  gatewayId: string;
}> {
  if (
    process.env.CLOUDFLARE_API_TOKEN &&
    process.env.CLOUDFLARE_ACCOUNT_ID &&
    process.env.CLOUDFLARE_GATEWAY_ID
  ) {
    return {
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      gatewayId: process.env.CLOUDFLARE_GATEWAY_ID,
    };
  }

  const saved = getCloudflareConfigSaved();
  if (saved.apiToken && saved.accountId && saved.gatewayId) {
    return saved as { apiToken: string; accountId: string; gatewayId: string };
  }

  section("Cloudflare AI Gateway Setup");
  console.log(
    `  Configure Cloudflare Workers AI via AI Gateway\n`,
  );

  const accountId = await input("Paste your Cloudflare Account ID", saved.accountId);
  if (!accountId) error("Account ID is required.");

  const gatewayId = await input("Paste your Cloudflare AI Gateway ID", saved.gatewayId || "default");
  if (!gatewayId) error("Gateway ID is required.");

  const apiToken = await input("Paste your Cloudflare API Token (API Key)", saved.apiToken);
  if (!apiToken) error("API Token is required.");

  const config = { accountId: accountId.trim(), gatewayId: gatewayId.trim(), apiToken: apiToken.trim() };

  const save = await confirm("Save configuration for future use?", true);
  if (save) {
    writeFileSync(CLOUDFLARE_CONFIG_FILE, JSON.stringify(config, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    badge("success", "Configuration saved to " + CLOUDFLARE_CONFIG_FILE);
  }

  return config;
}

export async function fetchCloudflareModels(
  accountId: string,
  apiToken: string,
): Promise<string[]> {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`,
      {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return [];
    const json: any = await res.json();
    if (!json || !json.success || !Array.isArray(json.result)) return [];

    return json.result
      .map((m: any) => m.id)
      .filter((id: string) => id.startsWith("@cf/"));
  } catch {
    return [];
  }
}

export async function setupCloudflareInteractive(): Promise<{
  model: string;
  apiKey: string;
  upstreamUrl: string;
}> {
  const { accountId, gatewayId, apiToken } = await getCloudflareConfigInteractive();

  const upstreamUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/v1`;

  if (!process.env.PONTIS_UPSTREAM_URL)
    process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  if (!process.env.PONTIS_UPSTREAM_FORMAT)
    process.env.PONTIS_UPSTREAM_FORMAT = "openai";

  const spin = createSpinner("Fetching available Cloudflare models...");
  const rawModels = await fetchCloudflareModels(accountId, apiToken);
  spin.stop(
    rawModels.length > 0
      ? {
          type: "success",
          text: `Found ${rawModels.length} model${rawModels.length === 1 ? "" : "s"} total`,
        }
      : { type: "warning", text: "Using fallback model lists" },
  );

  const categoryChoices = [
    CLOUDFLARE_CATEGORIES.flagship.name,
    CLOUDFLARE_CATEGORIES.cheap.name,
    CLOUDFLARE_CATEGORIES.vision.name,
    "📁 All Available Models (Full List)",
    "✏️ Enter Custom Model ID",
  ];

  const catResult = await select("Choose a model category", categoryChoices);
  let selectedModel = "";

  if (catResult.index === 0) {
    // Flagship
    const matched = rawModels.filter(m =>
      CLOUDFLARE_CATEGORIES.flagship.keywords.some(k => m.toLowerCase().includes(k))
    );
    const modelsToPresent = matched.length > 0 ? matched : CLOUDFLARE_CATEGORIES.flagship.fallbacks;
    const modelRes = await select("Choose flagship/coding model", modelsToPresent);
    selectedModel = modelRes.index === -1 ? await input("Enter model ID") : modelRes.value;
  } else if (catResult.index === 1) {
    // Cheap
    const matched = rawModels.filter(m =>
      CLOUDFLARE_CATEGORIES.cheap.keywords.some(k => m.toLowerCase().includes(k))
    );
    const modelsToPresent = matched.length > 0 ? matched : CLOUDFLARE_CATEGORIES.cheap.fallbacks;
    const modelRes = await select("Choose lightweight model", modelsToPresent);
    selectedModel = modelRes.index === -1 ? await input("Enter model ID") : modelRes.value;
  } else if (catResult.index === 2) {
    // Vision
    const matched = rawModels.filter(m =>
      CLOUDFLARE_CATEGORIES.vision.keywords.some(k => m.toLowerCase().includes(k))
    );
    const modelsToPresent = matched.length > 0 ? matched : CLOUDFLARE_CATEGORIES.vision.fallbacks;
    const modelRes = await select("Choose vision model", modelsToPresent);
    selectedModel = modelRes.index === -1 ? await input("Enter model ID") : modelRes.value;
  } else if (catResult.index === 3) {
    // Full List
    const modelsToPresent = rawModels.length > 0 ? rawModels : CLOUDFLARE_FALLBACK_MODELS;
    const modelRes = await select("Choose from all models", modelsToPresent);
    selectedModel = modelRes.index === -1 ? await input("Enter model ID") : modelRes.value;
  } else {
    // Custom Model ID
    selectedModel = await input("Enter custom model ID", "@cf/moonshotai/kimi-k2.6");
  }

  if (!selectedModel) {
    selectedModel = "@cf/moonshotai/kimi-k2.6";
  }

  return { model: selectedModel, apiKey: apiToken, upstreamUrl };
}
