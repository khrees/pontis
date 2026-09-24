import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { select, input, inputRequired, createSpinner, badge, t } from "./ui";
import { CACHE_FILE, getOpenCodeApiKey } from "./config";
import { storeOpenCodeApiKey } from "../secure-storage";
import { getPreferences, savePreferences } from "./preferences";
import { isFreeOpenCodeModel, registerFreeOpenCodeModels, registerOpenCodeCatalogs } from "../opencode-models";

const EXCLUDED_FREE_MODELS = new Set([
  "minimax-m3-free",
]);

export async function getOpenCodeApiKeyInteractive(): Promise<string> {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;

  const secureKey = getOpenCodeApiKey();
  if (secureKey) return secureKey;

  console.log(
    `  1. Open ${t.secondary("https://opencode.ai/console")} in your browser`,
  );
  console.log(
    `  2. Create a Service Account (e.g. named ${t.bold('"pontis"')}) under Service Accounts`,
  );
  console.log(
    `  3. Generate and copy an API key for that Service Account`,
  );
  const key = await input("Paste your OpenCode Service Account API key", undefined, true);
  if (!key || !key.trim()) {
    badge("error", "API key is required to use OpenCode cloud models.");
    process.exit(1);
  }

  const cleanKey = key.trim();
  storeOpenCodeApiKey(cleanKey);
  badge("success", "API key saved securely");
  return cleanKey;
}

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

const FRONTIER_FAMILY_ORDER = [
  "claude-opus",
  "claude-sonnet",
  "claude-haiku",
  "claude-fable",
  "claude",
  "gpt-6",
  "gpt-5.6",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt",
  "o4",
  "o3",
  "o1",
  "gemini-3.8",
  "gemini-3.7",
  "gemini-3.6",
  "gemini-3.5",
  "gemini-3.1",
  "gemini-3",
  "gemini",
  "grok-4",
  "grok",
  "muse-spark",
  "muse",
];

const CHINESE_FAMILY_ORDER = [
  "deepseek",
  "kimi",
  "glm",
  "qwen",
  "minimax",
  "hy",
  "mimo",
  "ling",
];

const OTHERS_FAMILY_ORDER = [
  "longcat",
  "omen",
  "jev",
  "llama",
  "mistral",
  "codestral",
];

const FREE_FAMILY_ORDER = [
  "muse-spark",
  "big-pickle",
  "ling",
  "nemotron",
  "mimo",
  "jev",
];

function getFamilyIndex(model: string, order: string[]): number {
  const lower = model.toLowerCase();
  for (let i = 0; i < order.length; i++) {
    if (lower.startsWith(order[i])) return i;
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

export interface OpenCodeModelGroups {
  free: string[];
  frontier: string[];
  chinese: string[];
  others: string[];
  combined: string[];
  zen: string[];
  go: string[];
}

export function categorizeOpenCodeModels(models: string[]): {
  free: string[];
  frontier: string[];
  chinese: string[];
  others: string[];
} {
  const free: string[] = [];
  const frontier: string[] = [];
  const chinese: string[] = [];
  const others: string[] = [];

  for (const raw of models) {
    const m = raw.trim();
    if (!m || m.startsWith("test") || m.includes("placeholder") || m === "model-created-by") continue;
    const lower = m.toLowerCase();

    // 1. Free takes first precedence for all free-tier models
    if (
      (isFreeOpenCodeModel(m) ||
        lower.endsWith("-free") ||
        lower === "big-pickle" ||
        lower.includes("contributor-free")) &&
      !(lower.startsWith("muse-") && !lower.includes("free"))
    ) {
      free.push(m);
    }
    // 2. Frontier: Claude, GPT / OpenAI, Gemini, Grok (xAI), Muse Spark (Meta), and o-series reasoning
    else if (
      lower.startsWith("claude-") ||
      lower.startsWith("gpt-") ||
      lower.startsWith("gemini-") ||
      lower.startsWith("o1") ||
      lower.startsWith("o3") ||
      lower.startsWith("o4") ||
      lower.startsWith("grok") ||
      lower.startsWith("muse-spark") ||
      lower.startsWith("muse-")
    ) {
      frontier.push(m);
    }
    // 3. Chinese: DeepSeek, Kimi, GLM, Qwen, MiniMax, Hunyuan, Mimo, Ling
    else if (
      lower.startsWith("deepseek") ||
      lower.startsWith("kimi-") ||
      lower.startsWith("glm-") ||
      lower.startsWith("qwen") ||
      lower.startsWith("minimax-") ||
      lower.startsWith("hy") ||
      lower.startsWith("mimo-") ||
      lower.startsWith("ling-")
    ) {
      chinese.push(m);
    }
    // 4. Others: Longcat, Omen, Jev (paid), Llama, Mistral, etc.
    else {
      others.push(m);
    }
  }

  const sortedFree = sortCategoryModels(free, FREE_FAMILY_ORDER);
  const sortedFrontier = sortCategoryModels(frontier, FRONTIER_FAMILY_ORDER);
  const sortedChinese = sortCategoryModels(chinese, CHINESE_FAMILY_ORDER);
  const sortedOthers = sortCategoryModels(others, OTHERS_FAMILY_ORDER);

  return {
    free: sortedFree,
    frontier: sortedFrontier,
    chinese: sortedChinese,
    others: sortedOthers,
  };
}

async function fetchEndpointModels(apiKey: string, url: string): Promise<string[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const json: any = await res.json();
      if (!json || !Array.isArray(json.data)) return [];
      return json.data
        .map((m: any) => (typeof m === "string" ? m : m?.id))
        .filter((id: any) => id && typeof id === "string" && !EXCLUDED_FREE_MODELS.has(id) && !id.startsWith("test"));
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return [];
}

export async function fetchOpenCodeModelsGrouped(
  apiKey: string,
  forceRefresh = false,
): Promise<OpenCodeModelGroups> {
  if (!forceRefresh && existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      if (
        Array.isArray(cache.models) &&
        typeof cache.timestamp === "number" &&
        Date.now() - cache.timestamp < 300000
      ) {
        const cleanModels = cache.models.filter(
          (m: string) => typeof m === "string" && !m.startsWith("test"),
        );
        const cats = categorizeOpenCodeModels(cleanModels);
        const freeList: string[] = Array.isArray(cache.freeModels) ? cache.freeModels : cats.free;
        if (freeList.length > 0) registerFreeOpenCodeModels(freeList);
        const zen: string[] = Array.isArray(cache.zen) ? cache.zen : [];
        const go: string[] = Array.isArray(cache.go) ? cache.go : [];
        registerOpenCodeCatalogs(zen, go);
        return {
          free: freeList,
          frontier: Array.isArray(cache.frontier) ? cache.frontier : cats.frontier,
          chinese: Array.isArray(cache.chinese) ? cache.chinese : cats.chinese,
          others: Array.isArray(cache.others) ? cache.others : cats.others,
          combined: cleanModels,
          zen,
          go,
        };
      }
    } catch {}
  }

  const [zenList, goList] = await Promise.all([
    fetchEndpointModels(apiKey, "https://opencode.ai/zen/v1/models"),
    fetchEndpointModels(apiKey, "https://opencode.ai/zen/go/v1/models"),
  ]);

  const rawCombined = Array.from(new Set([...zenList, ...goList])).filter(
    (id) => typeof id === "string" && !id.startsWith("test"),
  );
  const cats = categorizeOpenCodeModels(rawCombined);

  if (cats.free.length > 0) registerFreeOpenCodeModels(cats.free);
  registerOpenCodeCatalogs(zenList, goList);

  if (rawCombined.length > 0) {
    try {
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(
        CACHE_FILE,
        JSON.stringify({
          timestamp: Date.now(),
          models: rawCombined,
          freeModels: cats.free,
          free: cats.free,
          frontier: cats.frontier,
          chinese: cats.chinese,
          others: cats.others,
          zen: zenList,
          go: goList,
        }),
        { encoding: "utf-8", mode: 0o600 },
      );
    } catch {}
  }

  return {
    free: cats.free,
    frontier: cats.frontier,
    chinese: cats.chinese,
    others: cats.others,
    combined: rawCombined,
    zen: zenList,
    go: goList,
  };
}

export async function setupOpenCodeInteractive(): Promise<{
  model: string;
  apiKey: string;
}> {
  const apiKey = await getOpenCodeApiKeyInteractive();

  const spin = createSpinner("Fetching live available models from OpenCode...");
  const groups = await fetchOpenCodeModelsGrouped(apiKey);
  const total = groups.combined.length;

  if (total > 0) {
    spin.stop({
      type: "success",
      text: `${total} OpenCode models available (Inference API)`,
    });
  } else {
    spin.stop({ type: "warning", text: "No models returned from OpenCode API" });
  }

  let model: string;
  if (total === 0) {
    model = await input("Enter model ID (e.g. gpt-5.4-mini, claude-sonnet-4-6, kimi-k2.6)", "gpt-5.4-mini");
    if (!model) model = "gpt-5.4-mini";
  } else {
    const prefs = getPreferences();
    const activeModel = prefs.providerModels?.opencode || prefs.defaultModel;

    const categories: { key: string; name: string; desc: string; models: string[] }[] = [];

    if (groups.free.length > 0) {
      categories.push({
        key: "free",
        name: "Free",
        desc: `${groups.free.length} models · Nemotron, Ling, Muse, Big Pickle`,
        models: groups.free,
      });
    }

    if (groups.frontier.length > 0) {
      categories.push({
        key: "frontier",
        name: "Frontier",
        desc: `${groups.frontier.length} models · Claude, GPT-5, Gemini, Grok, Muse`,
        models: groups.frontier,
      });
    }

    if (groups.chinese.length > 0) {
      categories.push({
        key: "chinese",
        name: "Chinese",
        desc: `${groups.chinese.length} models · DeepSeek, Kimi, GLM, Qwen, MiniMax`,
        models: groups.chinese,
      });
    }

    if (groups.others.length > 0) {
      categories.push({
        key: "others",
        name: "Others",
        desc: `${groups.others.length} models · Longcat, Omen, Jev`,
        models: groups.others,
      });
    }

    if (categories.length === 0 && total > 0) {
      categories.push({
        key: "all",
        name: "All Models",
        desc: `${total} models · Complete list`,
        models: groups.combined,
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

    const catResult = await select("Pick OpenCode model category", catChoices, {
      allowCustom: false,
      defaultIndex: defaultCatIdx,
    });

    const selectedCategory = categories[catResult.index] || categories[0];
    const list = selectedCategory.models;

    const defaultIdx =
      activeModel && list.indexOf(activeModel) >= 0 ? list.indexOf(activeModel) : 0;

    const pickPrompt = selectedCategory.key === "others"
      ? "Pick an Others model"
      : `Pick a ${selectedCategory.name} model`;

    const result = await select(pickPrompt, list, {
      defaultIndex: defaultIdx,
      customLabel: "Custom model ID (enter manually)",
    });

    if (result.index === -1) {
      model = await inputRequired("Enter model ID");
    } else {
      model = result.value;
    }

    if (selectedCategory.key === "free") {
      console.log(`\n  ${t.muted("ℹ Note: Free models are restricted to OpenCode in-app usage; external keys may receive FreeTierError.")}\n`);
    }
  }

  savePreferences({ defaultModel: model, defaultProvider: "opencode" });
  return { model, apiKey };
}
