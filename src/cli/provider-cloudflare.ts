import { writeFileSync } from "node:fs";
import { t, select, input, inputRequired, createSpinner, badge, error } from "./ui";
import {
  CLOUDFLARE_CONFIG_FILE,
  getCloudflareConfigSaved,
} from "./config";
import { storeCloudflareApiToken } from "../secure-storage";
import { getPreferences, savePreferences } from "./preferences";

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
      `  ${t.muted("Saved Cloudflare config found — press Enter to keep or type new values to update.")}`,
    );
  } else {
    console.log(
      `  Configure Cloudflare Workers AI via AI Gateway`,
    );
  }

  const accountId = await input("Paste your Cloudflare Account ID", saved.accountId);
  if (!accountId) error("Account ID is required.");

  const gatewayId = await input("Paste your Cloudflare AI Gateway ID", saved.gatewayId || "default");
  if (!gatewayId) error("Gateway ID is required.");

  const apiToken = await input("Paste your Cloudflare API Token (API Key)", saved.apiToken, true);
  if (!apiToken) error("API Token is required.");

  const config = { accountId: accountId.trim(), gatewayId: gatewayId.trim(), apiToken: apiToken.trim() };

  // Persist only non-secret fields to disk; the API token lives only in the
  // encrypted vault (storeCloudflareApiToken below), never in plaintext.
  writeFileSync(CLOUDFLARE_CONFIG_FILE, JSON.stringify({ accountId: config.accountId, gatewayId: config.gatewayId }, null, 2), {
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
          text: `Found ${rawModels.length} model${rawModels.length === 1 ? "" : "s"} available`,
        }
      : { type: "warning", text: "No models returned from Cloudflare API" },
  );

  let selectedModel = "";
  // Cloudflare model IDs always start with "@cf/".
  const validateCfModelId = (v: string): string | null =>
    v.startsWith("@cf/")
      ? null
      : "Cloudflare model IDs start with @cf/ (e.g. @cf/meta/llama-3.3-70b-instruct)";

  if (rawModels.length === 0) {
    selectedModel = await inputRequired(
      "Enter your Cloudflare model ID (e.g. @cf/meta/llama-3.3-70b-instruct)",
      validateCfModelId,
    );
  } else {
    const prefs = getPreferences();
    const activeModel = prefs.providerModels?.cloudflare || prefs.defaultModel;
    const defaultIdx = activeModel && rawModels.indexOf(activeModel) >= 0 ? rawModels.indexOf(activeModel) : 0;
    const modelRes = await select("Choose a Cloudflare model", rawModels, {
      defaultIndex: defaultIdx,
      customLabel: "Custom model ID (enter manually)",
    });
    if (modelRes.index === -1) {
      // Custom entry: don't silently fall back to the list item they declined.
      selectedModel = await inputRequired("Enter model ID", validateCfModelId);
    } else {
      selectedModel = modelRes.value;
    }
  }

  savePreferences({ defaultModel: selectedModel, defaultProvider: "cloudflare" });

  return { model: selectedModel, apiKey: apiToken, upstreamUrl };
}
