import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isNodeEnvironment =
  typeof process !== "undefined" &&
  process.versions !== undefined &&
  process.versions.node !== undefined;

const FREE_MODEL_EXCEPTIONS = new Set(["big-pickle"]);

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
}

export function getKnownFreeModels(): string[] {
  const all = new Set<string>([...FREE_MODEL_EXCEPTIONS, ...discoveredFreeModels]);
  return Array.from(all);
}

export function isFreeOpenCodeModel(model: string, modelObj?: any): boolean {
  if (!model && !modelObj) return false;

  const id = typeof model === "string" ? model.trim() : (modelObj?.id ? String(modelObj.id).trim() : "");
  if (!id) return false;

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

  // 2. Suffix / naming pattern conventions
  const lower = id.toLowerCase();
  if (
    lower.endsWith("-free") ||
    lower.endsWith("_free") ||
    lower.includes("-free-") ||
    lower.includes(":free") ||
    lower.includes("/free")
  ) {
    return true;
  }

  // 3. Static exception set
  if (FREE_MODEL_EXCEPTIONS.has(lower) || FREE_MODEL_EXCEPTIONS.has(id)) {
    return true;
  }

  // 4. Dynamically registered / verified free models
  if (discoveredFreeModels.has(id) || discoveredFreeModels.has(lower)) {
    return true;
  }

  // 5. Check persistent cache if running in Node environment
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

