import { extractApiKey, validateApiKey, authErrorResponse } from "../auth";
import {
  getDefaultFreeModel,
  getUpstream,
  isCodexClient,
  upstreamFormat,
  type RouteConfig,
} from "../config";
import { fetchWithTimeout, anthropicHeaders, jsonResponse, upstreamErrorResponse } from "../http";
import {
  buildCodexModelEntry,
  KNOWN_MODEL_METADATA,
} from "../model-metadata";
import { UpstreamError, errorToResponse } from "../errors";

/**
 * Returns true for models that should be filtered OUT.
 * We only filter clearly non-relevant system models (like "model-created-by"),
 * not unknown — those get sensible defaults.
 */
function isFilteredOut(id: string): boolean {
  // Remove known junk/placeholder models that some providers inject
  if (id.includes("placeholder") || id === "model-created-by" || id.startsWith(".")) return true;
  return false;
}

export async function handleModelsRequest(
  request: Request,
  route: RouteConfig,
): Promise<Response> {
  try {
    const key = extractApiKey(request.headers);
    const upstream = getUpstream(route.upstream);
    const fmt = upstreamFormat();
    
    if (upstream.includes("opencode.ai")) {
      validateApiKey(key);
    }

    const res =
      fmt === "anthropic"
        ? await fetchWithTimeout(`${upstream}/v1/models`, {
            method: "GET",
            headers: anthropicHeaders(request, key!),
          })
        : await fetchWithTimeout(`${upstream}/models`, {
            method: "GET",
            headers: {
              ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
          });

    if (!res.ok) {
      throw new UpstreamError(
        "Failed to fetch models from upstream",
        res.status,
        await res.text()
      );
    }

    const url = new URL(request.url);

    // For non-Codex clients, pass through the raw model list as-is
    if (!isCodexClient(request, url)) {
      return new Response(await res.text(), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // For Codex CLI: build structured model metadata entries
    const data = (await res.json()) as { data?: { id: string }[] };
    const upstreamModels = (data.data || []).map((m) => m.id).filter((id) => !isFilteredOut(id));

    // Merge upstream models with known metadata overrides
    const seen = new Set<string>();
    const modelEntries = [];

    for (const id of upstreamModels) {
      seen.add(id);
      modelEntries.push(buildCodexModelEntry(id));
    }

    // Ensure any locally-known models not present upstream are still advertised
    for (const id of Object.keys(KNOWN_MODEL_METADATA)) {
      if (!seen.has(id)) {
        seen.add(id);
        modelEntries.push(buildCodexModelEntry(id));
      }
    }

    // Ensure the default model is always present
    const defaultModel = getDefaultFreeModel();
    if (defaultModel && !seen.has(defaultModel)) {
      modelEntries.push(buildCodexModelEntry(defaultModel));
    }

    if (route.path.startsWith("/v1/models/")) {
      const modelId = route.path.split("/").pop()!;
      const matched = modelEntries.find((m) => m.slug === modelId);
      return jsonResponse(matched ?? buildCodexModelEntry(modelId));
    }

    return jsonResponse({ models: modelEntries });
  } catch (error) {
    return errorToResponse(error);
  }
}
