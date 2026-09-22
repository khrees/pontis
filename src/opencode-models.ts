import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isNodeEnvironment =
  typeof process !== "undefined" &&
  process.versions !== undefined &&
  process.versions.node !== undefined;

const FREE_MODEL_EXCEPTIONS = new Set([
  "big-pickle",
]);

/**
 * Paid model prefixes that must NEVER be treated as free, even if they have
 * permissive tags or ambiguous names.
 */
const NON_FREE_PREFIXES = [
  "kimi",
  "glm",
  "grok",
  "minimax",
  "claude",
  "gpt",
  "gemini",
  "qwen",
];

const KNOWN_OPENCODE_RESPONSES_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-nano",
]);

const discoveredFreeModels = new Set<string>();

export function registerFreeOpenCodeModel(model: string): void {
  if (model && typeof model === "string") {
    discoveredFreeModels.add(model.trim());
  }
}

export function registerFreeOpenCodeModels(models: string[]): void {
  for (const m of models) {
    if (m && typeof m === "string") {
      discoveredFreeModels.add(m.trim());
    }
  }
}

export function clearDiscoveredFreeModels(): void {
  discoveredFreeModels.clear();
  knownZenModels.clear();
  knownGoModels.clear();
  catalogLoaded = false;
}

const knownZenModels = new Set<string>();
const knownGoModels = new Set<string>();
let catalogLoaded = false;

export function registerOpenCodeCatalogs(zen: string[], go: string[]): void {
  for (const m of zen) {
    if (m && typeof m === "string") {
      knownZenModels.add(m.trim());
      knownZenModels.add(m.trim().toLowerCase());
    }
  }
  for (const m of go) {
    if (m && typeof m === "string") {
      knownGoModels.add(m.trim());
      knownGoModels.add(m.trim().toLowerCase());
    }
  }
  if (zen.length > 0 || go.length > 0) catalogLoaded = true;
}

function loadCatalogFromCache(): void {
  if (catalogLoaded || !isNodeEnvironment) return;
  try {
    const cacheFile = process.env.PONTIS_DIR
      ? join(process.env.PONTIS_DIR, "models_cache.json")
      : join(homedir(), ".pontis", "models_cache.json");
    if (!existsSync(cacheFile)) return;
    const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
    if (Array.isArray(cache.zen) && Array.isArray(cache.go)) {
      registerOpenCodeCatalogs(cache.zen, cache.go);
    }
  } catch {}
}

const RESPONSES_API_PREFIXES = [
  "muse-spark",
  "muse-glimmer",
  "gpt-",
  "o1",
  "o3",
  "grok-",
];

export function isResponsesApiModel(model: string): boolean {
  if (!model || typeof model !== "string") return false;
  const lower = model.trim().toLowerCase();
  const slashIdx = lower.lastIndexOf("/");
  const id = slashIdx > 0 ? lower.slice(slashIdx + 1) : lower;
  if (KNOWN_OPENCODE_RESPONSES_MODELS.has(id)) return true;
  return RESPONSES_API_PREFIXES.some((p) => id.startsWith(p));
}

export function resolveOpenCodeTier(model: string): "zen" | "go" | null {
  if (!model || typeof model !== "string") return null;
  const id = model.trim();
  if (!id) return null;
  if (isFreeOpenCodeModel(id)) return "zen";
  loadCatalogFromCache();
  const lower = id.toLowerCase();
  if (knownGoModels.has(id) || knownGoModels.has(lower)) return "go";
  if (knownZenModels.has(id) || knownZenModels.has(lower)) return "zen";
  return null;
}

export function isFreeOpenCodeModel(model: string, modelObj?: any): boolean {
  if (!model && !modelObj) return false;

  const id = typeof model === "string" ? model.trim() : (modelObj?.id ? String(modelObj.id).trim() : "");
  if (!id) return false;

  const lower = id.toLowerCase();

  // Explicitly reject non-free prefixes: kimi, glm, grok, minimax, claude, gpt, gemini, qwen
  if (NON_FREE_PREFIXES.some((p) => lower.startsWith(p))) {
    return false;
  }

  // Non-free muse-spark models (Meta) are paid frontier models
  if (lower.startsWith("muse-") && !lower.includes("free")) {
    return false;
  }

  if (modelObj && typeof modelObj === "object") {
    if (modelObj.free === true || modelObj.is_free === true) return true;
    if (
      modelObj.pricing &&
      (modelObj.pricing.input === 0 || modelObj.pricing.prompt === 0) &&
      (modelObj.pricing.output === 0 || modelObj.pricing.completion === 0)
    ) {
      return true;
    }
    if (modelObj.owned_by === "opencode-free" || modelObj.owned_by === "zen") return true;
    if (Array.isArray(modelObj.tags) && (modelObj.tags.includes("free") || modelObj.tags.includes("zen"))) {
      return true;
    }
  }

  // Suffix / naming pattern conventions
  if (
    lower.endsWith("-free") ||
    lower.endsWith("_free") ||
    lower.includes("-free-") ||
    lower.includes(":free") ||
    lower.includes("/free")
  ) {
    return true;
  }

  // Static exception set (e.g. big-pickle)
  if (FREE_MODEL_EXCEPTIONS.has(lower) || FREE_MODEL_EXCEPTIONS.has(id)) {
    return true;
  }

  // Free model families without explicit -free suffix: nemotron, ling, mimo
  if (
    lower.startsWith("nemotron") ||
    lower.startsWith("ling") ||
    lower.startsWith("mimo")
  ) {
    return true;
  }

  // Dynamically registered / verified free models
  if (discoveredFreeModels.has(id) || discoveredFreeModels.has(lower)) {
    return true;
  }

  // Check persistent cache if running in Node environment
  if (isNodeEnvironment) {
    try {
      const cacheFile = process.env.PONTIS_DIR
        ? join(process.env.PONTIS_DIR, "models_cache.json")
        : join(homedir(), ".pontis", "models_cache.json");
      if (existsSync(cacheFile)) {
        const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
        const freeList: string[] = Array.isArray(cache.freeModels)
          ? cache.freeModels
          : (Array.isArray(cache.models) ? cache.models.filter((m: string) => typeof m === "string" && (m.endsWith("-free") || FREE_MODEL_EXCEPTIONS.has(m))) : []);
        if (freeList.includes(id) || freeList.includes(lower)) {
          discoveredFreeModels.add(id);
          return true;
        }
      }
    } catch {}
  }

  return false;
}

/**
 * Decoy tool definitions for Chat Completions API.
 * OpenCode's free-tier gateway validates that requests contain built-in tool
 * schemas (at minimum `bash` and `read`). Without these, requests to free
 * models return 403 FreeTierError.
 */
const OPENCODE_DECOY_CHAT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "bash",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read",
      description: "Read a file from the filesystem",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "The absolute path to the file" },
        },
        required: ["file_path"],
      },
    },
  },
];

/**
 * Decoy tool definitions for Responses API (muse-spark, gpt-* etc.).
 */
const OPENCODE_DECOY_RESPONSES_TOOLS = [
  {
    type: "function" as const,
    name: "bash",
    description: "Execute a shell command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
      },
      required: ["command"],
    },
  },
  {
    type: "function" as const,
    name: "read",
    description: "Read a file from the filesystem",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The absolute path to the file" },
      },
      required: ["file_path"],
    },
  },
];

/**
 * Inject decoy tools into a request body if the model is a free-tier OpenCode
 * model and the request doesn't already have `bash` and `read` tools.
 *
 * @param body The parsed request body (mutated in place)
 * @param model The resolved model ID
 * @param isResponses Whether this is a Responses API request
 * @returns true if tools were injected
 */
export function injectDecoyToolsIfNeeded(
  body: Record<string, any>,
  model: string,
  isResponses = false,
): boolean {
  if (!isFreeOpenCodeModel(model)) return false;

  const existing: any[] = Array.isArray(body.tools) ? body.tools : [];

  // Check if bash and read already exist (exact lowercase match)
  const hasDecoy = (name: string) =>
    existing.some((t: any) => {
      if (isResponses) return t.name === name;
      return t.function?.name === name;
    });

  if (hasDecoy("bash") && hasDecoy("read")) return false;

  const decoys = isResponses ? OPENCODE_DECOY_RESPONSES_TOOLS : OPENCODE_DECOY_CHAT_TOOLS;

  const toInject = decoys.filter((d) => {
    const name = isResponses ? (d as any).name : (d as any).function.name;
    return !hasDecoy(name);
  });

  body.tools = [...toInject, ...existing];
  return toInject.length > 0;
}
