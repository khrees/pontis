import { writeFileSync } from "node:fs";
import { t, select, input, inputRequired, createSpinner, badge, error } from "./ui";
import {
  CLOUDFLARE_CONFIG_FILE,
  getCloudflareConfigSaved,
  getCloudflareUpstreamUrl,
} from "./config";
import { storeCloudflareApiToken } from "../secure-storage";
import { getPreferences, savePreferences } from "./preferences";

export const DEFAULT_CLOUDFLARE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Verified 2026 Cloudflare Workers AI Text Generation Model Catalog
 * Sourced directly from official Cloudflare Workers AI model registry.
 */
export const KNOWN_CLOUDFLARE_MODELS = [
  // Free Models (Available on Workers AI Free allocation)
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/qwen/qwen3.8-27b",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/ibm-granite/granite-4.0-h-micro",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/qwen/qwq-32b",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/google/gemma-7b-it-lora",
  "@cf/google/gemma-2b-it-lora",
  "@cf/mistral/mistral-7b-instruct-v0.2-lora",
  "@cf/meta-llama/llama-2-7b-chat-hf-lora",
  "@cf/aisingapore/gemma-sea-lion-v4-27b-it",
  "@cf/meta/llama-guard-3-8b",
  // Paid Models (Requires Workers Paid plan or prepaid AI Gateway credits)
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/zai-org/glm-5.2",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/moonshotai/kimi-k2.6",
] as const;

export const CLOUDFLARE_PAID_MODELS = new Set([
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
]);

function extractNumbers(str: string): number[] {
  const m = str.match(/\d+(?:\.\d+)?/g);
  if (!m) return [0];
  return m.flatMap((p) => p.split(".").map(Number));
}

export function compareModelVersionsDesc(a: string, b: string): number {
  const numsA = extractNumbers(a);
  const numsB = extractNumbers(b);
  const len = Math.max(numsA.length, numsB.length);
  for (let i = 0; i < len; i++) {
    const nA = numsA[i] ?? 0;
    const nB = numsB[i] ?? 0;
    if (nA !== nB) return nB - nA; // descending
  }
  return a.localeCompare(b);
}

const FREE_FAMILY_ORDER = [
  "llama-3.3",
  "deepseek-r1",
  "qwen2.5-coder",
  "llama-4",
  "gpt-oss",
  "qwen3.8",
  "gemma-4",
  "mistral-small",
  "glm-4",
  "nemotron",
  "granite",
  "llama-3.2",
  "llama-3.1",
  "qwen3",
  "qwq",
];

const FRONTIER_FAMILY_ORDER = [
  "deepseek-v4",
  "glm-5",
  "kimi-k2.7",
  "kimi-k2.6",
  "llama-4",
  "gpt-oss",
  "llama-3.3",
  "gemma-4",
  "deepseek-r1",
];

const CHINESE_FAMILY_ORDER = [
  "deepseek-v4",
  "deepseek-r1",
  "glm-5",
  "glm-4",
  "kimi-k2.7",
  "kimi-k2.6",
  "qwen2.5-coder",
  "qwen3.8",
  "qwen3",
  "qwq",
];

const OTHERS_FAMILY_ORDER = [
  "llama-4",
  "llama-3.3",
  "llama-3.2",
  "llama-3.1",
  "gemma-4",
  "gemma",
  "mistral-small",
  "mistral",
  "nemotron",
  "granite",
  "sea-lion",
  "llama-2",
];

function getFamilyIndex(model: string, order: string[]): number {
  const lower = model.toLowerCase();
  for (let i = 0; i < order.length; i++) {
    if (lower.includes(order[i])) return i;
  }
  return 999;
}

function sortCategoryModels(models: string[], familyOrder?: string[]): string[] {
  if (!familyOrder) {
    return [...models].sort(compareModelVersionsDesc);
  }
  return [...models].sort((a, b) => {
    const famA = getFamilyIndex(a, familyOrder);
    const famB = getFamilyIndex(b, familyOrder);
    if (famA !== famB) return famA - famB;
    return compareModelVersionsDesc(a, b);
  });
}

export interface CloudflareModelGroups {
  free: string[];
  frontier: string[];
  chinese: string[];
  others: string[];
  all: string[];
}

export function categorizeCloudflareModels(models: string[]): CloudflareModelGroups {
  const free: string[] = [];
  const frontier: string[] = [];
  const chinese: string[] = [];
  const others: string[] = [];

  for (const raw of models) {
    const m = raw.trim();
    if (!m || !m.startsWith("@cf/")) continue;
    const lower = m.toLowerCase();

    // 1. Free: any model not restricted to paid billing
    if (!CLOUDFLARE_PAID_MODELS.has(m)) {
      free.push(m);
    }

    // 2. Frontier: paid flagship reasoning/coding or high-capability open weights
    if (
      CLOUDFLARE_PAID_MODELS.has(m) ||
      lower.includes("llama-4") ||
      lower.includes("llama-3.3") ||
      lower.includes("gpt-oss") ||
      lower.includes("deepseek-r1") ||
      lower.includes("gemma-4")
    ) {
      frontier.push(m);
    }

    // 3. Chinese: DeepSeek, GLM / Zhipu AI, Moonshot / Kimi, Alibaba / Qwen
    if (
      lower.includes("deepseek") ||
      lower.includes("glm") ||
      lower.includes("zai-org") ||
      lower.includes("kimi") ||
      lower.includes("moonshotai") ||
      lower.includes("qwen") ||
      lower.includes("qwq")
    ) {
      chinese.push(m);
    }

    // 4. Others: Meta Llama, Google Gemma, Mistral, NVIDIA, IBM Granite, AI Singapore
    if (
      lower.includes("meta") ||
      lower.includes("llama") ||
      lower.includes("google") ||
      lower.includes("gemma") ||
      lower.includes("mistral") ||
      lower.includes("nvidia") ||
      lower.includes("nemotron") ||
      lower.includes("ibm") ||
      lower.includes("granite") ||
      lower.includes("aisingapore") ||
      lower.includes("sea-lion")
    ) {
      others.push(m);
    }
  }

  return {
    free: sortCategoryModels(free, FREE_FAMILY_ORDER),
    frontier: sortCategoryModels(frontier, FRONTIER_FAMILY_ORDER),
    chinese: sortCategoryModels(chinese, CHINESE_FAMILY_ORDER),
    others: sortCategoryModels(others, OTHERS_FAMILY_ORDER),
    all: sortCategoryModels(models.filter((m) => m.startsWith("@cf/")), FRONTIER_FAMILY_ORDER),
  };
}

export function sortCloudflareModels(models: string[]): string[] {
  return sortCategoryModels(models, FRONTIER_FAMILY_ORDER);
}

export async function getCloudflareConfigInteractive(): Promise<{
  apiToken: string;
  accountId: string;
  gatewayId: string;
}> {
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    return {
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      gatewayId: process.env.CLOUDFLARE_GATEWAY_ID || "",
    };
  }

  const saved = getCloudflareConfigSaved();
  const hasSaved = !!(saved.apiToken && saved.accountId);

  if (hasSaved) {
    console.log(
      `  ${t.muted("Saved Cloudflare config found — press Enter to keep or type new values to update.")}`,
    );
  } else {
    console.log(
      `  Configure Cloudflare Workers AI / AI Gateway`,
    );
  }

  const accountId = await input("Paste your Cloudflare Account ID", saved.accountId);
  if (!accountId) error("Account ID is required.");

  const gatewayId = await input("Paste your Cloudflare AI Gateway ID (optional, press Enter for direct Workers AI)", saved.gatewayId || "");

  const apiToken = await input("Paste your Cloudflare API Token (API Key)", saved.apiToken, true);
  if (!apiToken) error("API Token is required.");

  const config = {
    accountId: accountId.trim(),
    gatewayId: gatewayId ? gatewayId.trim() : "",
    apiToken: apiToken.trim(),
  };

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
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=100`,
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
      .filter((id: string) => typeof id === "string" && id.startsWith("@cf/"));
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

  const upstreamUrl = getCloudflareUpstreamUrl(accountId, gatewayId);

  if (!process.env.PONTIS_UPSTREAM_URL)
    process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  if (!process.env.PONTIS_UPSTREAM_FORMAT)
    process.env.PONTIS_UPSTREAM_FORMAT = "openai";

  const spin = createSpinner("Fetching available Cloudflare models...");
  const rawModels = await fetchCloudflareModels(accountId, apiToken);
  const total = rawModels.length;

  if (total > 0) {
    spin.stop({
      type: "success",
      text: `Found ${total} Cloudflare model${total === 1 ? "" : "s"} available`,
    });
  } else {
    spin.stop({
      type: "warning",
      text: "No models returned from Cloudflare API",
    });
  }

  let selectedModel = "";
  const validateCfModelId = (v: string): string | null =>
    v.startsWith("@cf/")
      ? null
      : "Cloudflare model IDs start with @cf/ (e.g. @cf/meta/llama-3.3-70b-instruct-fp8-fast)";

  if (total === 0) {
    selectedModel = await inputRequired(
      "Enter your Cloudflare model ID (e.g. @cf/meta/llama-3.3-70b-instruct-fp8-fast)",
      validateCfModelId,
    );
  } else {
    const prefs = getPreferences();
    const activeModel = prefs.providerModels?.cloudflare || prefs.defaultModel;

    const groups = categorizeCloudflareModels(rawModels);
    const categories: { key: string; name: string; desc: string; models: string[] }[] = [];

    if (groups.free.length > 0) {
      categories.push({
        key: "free",
        name: "Free",
        desc: `${groups.free.length} models · Llama-3.3, R1-Distill, Qwen-Coder, GPT-OSS`,
        models: groups.free,
      });
    }

    if (groups.frontier.length > 0) {
      categories.push({
        key: "frontier",
        name: "Frontier",
        desc: `${groups.frontier.length} models · DeepSeek-V4, GLM-5, Kimi-K2.7, Llama-4`,
        models: groups.frontier,
      });
    }

    if (groups.chinese.length > 0) {
      categories.push({
        key: "chinese",
        name: "Chinese",
        desc: `${groups.chinese.length} models · DeepSeek, GLM, Kimi, Qwen`,
        models: groups.chinese,
      });
    }

    if (groups.others.length > 0) {
      categories.push({
        key: "others",
        name: "Others",
        desc: `${groups.others.length} models · Llama, Gemma, Mistral, Nemotron, Granite`,
        models: groups.others,
      });
    }

    if (categories.length === 0 && total > 0) {
      categories.push({
        key: "all",
        name: "All Models",
        desc: `${total} models · Complete list`,
        models: rawModels,
      });
    }

    let defaultCatIdx = 0;
    if (activeModel) {
      const foundIdx = categories.findIndex((c) => c.models.includes(activeModel));
      if (foundIdx >= 0) defaultCatIdx = foundIdx;
    }

    const catChoices = categories.map(
      (c) => `${t.primary(c.name.padEnd(20))} ${t.muted(c.desc)}`,
    );

    const catResult = await select("Pick Cloudflare model category", catChoices, {
      allowCustom: false,
      defaultIndex: defaultCatIdx,
    });

    const selectedCategory = categories[catResult.index] || categories[0];
    const list = selectedCategory.models;

    const defaultIdx =
      activeModel && list.indexOf(activeModel) >= 0
        ? list.indexOf(activeModel)
        : list.indexOf(DEFAULT_CLOUDFLARE_MODEL) >= 0
          ? list.indexOf(DEFAULT_CLOUDFLARE_MODEL)
          : 0;

    const pickPrompt = selectedCategory.key === "others"
      ? "Pick an Others model"
      : `Pick a ${selectedCategory.name} model`;

    const modelRes = await select(pickPrompt, list, {
      defaultIndex: defaultIdx,
      customLabel: "Custom model ID (enter manually)",
    });

    if (modelRes.index === -1) {
      selectedModel = await inputRequired("Enter model ID", validateCfModelId);
    } else {
      selectedModel = modelRes.value;
    }
  }

  savePreferences({ defaultModel: selectedModel, defaultProvider: "cloudflare" });

  return { model: selectedModel, apiKey: apiToken, upstreamUrl };
}
