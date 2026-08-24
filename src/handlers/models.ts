import { extractApiKey, validateApiKey } from "../auth";
import {
  getDefaultFreeModel,
  getUpstream,
  isCodexClient,
  upstreamFormat,
  ZEN_UPSTREAM,
  type RouteConfig,
} from "../config";
import { fetchWithTimeout, anthropicHeaders, jsonResponse } from "../http";
import {
  buildCodexModelEntry,
  KNOWN_MODEL_METADATA,
} from "../model-metadata";
import { errorToResponse } from "../errors";
import { getProvider } from "../env";

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

/**
 * Detect Claude CLI / Anthropic SDK clients.
 * These clients send `anthropic-version` or use `x-api-key` (no Bearer prefix).
 * They expect a response shaped like Anthropic's GET /v1/models.
 */
function isAnthropicStyleClient(request: Request): boolean {
  return !!(
    request.headers.get("anthropic-version") ||
    (request.headers.get("x-api-key") && !request.headers.get("authorization"))
  );
}

/**
 * Build a single model entry in Anthropic's /v1/models shape.
 * https://docs.anthropic.com/en/api/models-list
 */
function buildAnthropicModelEntry(id: string) {
  return {
    id,
    display_name: id,
    type: "model" as const,
    created_at: new Date(0).toISOString(),
  };
}

/**
 * Attempt to fetch model IDs from an OpenAI-compatible /models endpoint.
 * Returns an empty array (never throws) so callers can always merge safely.
 */
async function fetchOpenAIModelIds(
  url: string,
  key: string | null,
): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(url, {
      method: "GET",
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data || []).map((m) => m.id).filter((id) => !isFilteredOut(id));
  } catch {
    return [];
  }
}

/**
 * Attempt to fetch model IDs from an Anthropic-compatible /v1/models endpoint.
 * Returns an empty array (never throws).
 */
async function fetchAnthropicModelIds(
  url: string,
  request: Request,
  key: string | null,
): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(url, {
      method: "GET",
      headers: anthropicHeaders(request, key ?? ""),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data || []).map((m) => m.id).filter((id) => !isFilteredOut(id));
  } catch {
    return [];
  }
}

export async function handleModelsRequest(
  request: Request,
  route: RouteConfig,
): Promise<Response> {
  try {
    const key = extractApiKey(request.headers);
    const upstream = getUpstream(route.upstream);
    const fmt = upstreamFormat();
    const provider = getProvider();

    const isOpencodeUpstream =
      upstream.includes("opencode.ai") || provider === "opencode";

    if (isOpencodeUpstream) {
      validateApiKey(key);
    }

    const url = new URL(request.url);

    // ── For Codex CLI: build structured model-metadata entries ───────────────
    // Always collect models from the opencode ZEN endpoint (our primary source)
    // and merge with whatever the configured upstream provides.
    if (isCodexClient(request, url)) {
      const seen = new Set<string>();
      const modelEntries: ReturnType<typeof buildCodexModelEntry>[] = [];

      function addModel(id: string): void {
        if (seen.has(id)) return;
        seen.add(id);
        modelEntries.push(buildCodexModelEntry(id));
      }

      // 1. Models from the opencode ZEN endpoint (always attempted)
      const opencodeIds = await fetchOpenAIModelIds(`${ZEN_UPSTREAM}/models`, key);
      for (const id of opencodeIds) addModel(id);

      // 2. Models from the configured upstream (may differ from opencode)
      if (!isOpencodeUpstream) {
        const upstreamIds =
          fmt === "anthropic"
            ? await fetchAnthropicModelIds(`${upstream}/v1/models`, request, key)
            : await fetchOpenAIModelIds(`${upstream}/models`, key);

        for (const id of upstreamIds) addModel(id);
      }

      // 3. Locally-known models not present from any upstream
      for (const id of Object.keys(KNOWN_MODEL_METADATA)) {
        addModel(id);
      }

      // 4. Always include the default model
      const defaultModel = getDefaultFreeModel();
      if (defaultModel) addModel(defaultModel);

      // ── Single-model lookup (/v1/models/:id) ─────────────────────────────────
      const reqPath = url.pathname;
      if (
        reqPath.startsWith("/v1/models/") ||
        reqPath.startsWith("/models/") ||
        route.path.startsWith("/v1/models/") ||
        route.path.startsWith("/models/")
      ) {
        const modelId = decodeURIComponent(
          (
            reqPath.startsWith("/v1/models/") || reqPath.startsWith("/models/")
              ? reqPath
              : route.path
          )
            .split("/")
            .pop()!,
        );
        const matched = modelEntries.find((m) => m.slug === modelId);
        return jsonResponse(matched ?? buildCodexModelEntry(modelId));
      }

      return jsonResponse({ models: modelEntries });
    }

    // ── Fetch opencode model IDs — used by both Anthropic and OpenAI clients ──
    // ZEN_UPSTREAM is always our canonical model source regardless of which
    // client/format is configured.
    let modelIds = await fetchOpenAIModelIds(`${ZEN_UPSTREAM}/models`, key);

    // If opencode returned nothing (e.g. auth issue), fall back to KNOWN_MODEL_METADATA
    if (modelIds.length === 0) {
      modelIds = Object.keys(KNOWN_MODEL_METADATA);
    }

    // Ensure the default model is always included
    const defaultModel = getDefaultFreeModel();
    if (defaultModel && !modelIds.includes(defaultModel)) {
      modelIds = [...modelIds, defaultModel];
    }

    // ── For Claude CLI / Anthropic SDK clients ───────────────────────────────
    // They call GET /v1/models expecting Anthropic's shape:
    //   { data: [{ id, display_name, type, created_at }], has_more, first_id, last_id }
    // Return opencode models in that exact shape so the client can list them.
    if (isAnthropicStyleClient(request)) {
      const data = modelIds.map(buildAnthropicModelEntry);
      return jsonResponse({
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
      });
    }

    // ── For generic OpenAI-compatible clients ────────────────────────────────
    // Return opencode models in OpenAI's /models shape:
    //   { object: "list", data: [{ id, object, created, owned_by }] }
    const now = Math.floor(Date.now() / 1000);
    return jsonResponse({
      object: "list",
      data: modelIds.map((id) => ({
        id,
        object: "model",
        created: now,
        owned_by: "opencode",
      })),
    });
  } catch (error) {
    return errorToResponse(error);
  }
}
