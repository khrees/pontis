import { writeFileSync } from "node:fs";
import { t, select, input, createSpinner, badge, section, error } from "./ui";
import {
  CLOUDFLARE_CONFIG_FILE,
  CLOUDFLARE_FALLBACK_MODELS,
  CLOUDFLARE_CATEGORIES,
  getCloudflareConfigSaved,
} from "./config";
import { storeCloudflareApiToken } from "../secure-storage";
import { savePreferences } from "./preferences";

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
  const hasSaved = !!(saved.apiToken && saved.accountId && saved.gatewayId);

  if (hasSaved) {
    console.log(
      `  ${t.muted("Saved Cloudflare config found — press Enter to keep or type new values to update.")}\n`,
    );
  } else {
    section("Cloudflare AI Gateway Setup");
    console.log(
      `  Configure Cloudflare Workers AI via AI Gateway\n`,
    );
  }

  const accountId = await input("Paste your Cloudflare Account ID", saved.accountId);
  if (!accountId) error("Account ID is required.");

  const gatewayId = await input("Paste your Cloudflare AI Gateway ID", saved.gatewayId || "default");
  if (!gatewayId) error("Gateway ID is required.");

  const apiToken = await input("Paste your Cloudflare API Token (API Key)", saved.apiToken, true);
  if (!apiToken) error("API Token is required.");

  const config = { accountId: accountId.trim(), gatewayId: gatewayId.trim(), apiToken: apiToken.trim() };

  // Save accountId/gatewayId to config file
  writeFileSync(CLOUDFLARE_CONFIG_FILE, JSON.stringify(config, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  // Save API token to encrypted secure storage
  storeCloudflareApiToken(config.apiToken);
  badge("success", "Cloudflare configuration saved securely");

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

  const categories = [
    CLOUDFLARE_CATEGORIES.flagship,
    CLOUDFLARE_CATEGORIES.cheap,
    CLOUDFLARE_CATEGORIES.vision,
  ];
  const categoryChoices = [
    ...categories.map((c) => c.name),
    "📁 All Available Models (Full List)",
    "✏️ Enter Custom Model ID",
  ];

  const catResult = await select("Choose a model category", categoryChoices);
  let selectedModel = "";

  const category = categories[catResult.index];
  if (category) {
    const matched = rawModels.filter((m) =>
      category.keywords.some((k) => m.toLowerCase().includes(k)),
    );
    const modelsToPresent = matched.length > 0 ? matched : category.fallbacks;
    const modelRes = await select(category.prompt, modelsToPresent);
    selectedModel = modelRes.index === -1 ? await input("Enter model ID") : modelRes.value;
  } else if (catResult.index === categories.length) {
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

  savePreferences({ defaultModel: selectedModel, defaultProvider: "cloudflare" });

  return { model: selectedModel, apiKey: apiToken, upstreamUrl };
}
