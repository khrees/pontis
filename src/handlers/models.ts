import { extractApiKey, validateApiKey, authErrorResponse } from "../auth";
import {
  getDefaultFreeModel,
  getUpstream,
  isCodexClient,
  upstreamFormat,
  type RouteConfig,
} from "../config";
import { anthropicHeaders, jsonResponse, upstreamErrorResponse } from "../http";
import {
  buildCodexModelEntry,
  KNOWN_MODEL_METADATA,
} from "../model-metadata";

export async function handleModelsRequest(
  request: Request,
  route: RouteConfig,
): Promise<Response> {
  const key = extractApiKey(request.headers);
  const upstream = getUpstream(request, route.upstream);
  const fmt = upstreamFormat(request);
  const authErr = upstream.includes("opencode.ai") ? validateApiKey(key) : null;
  if (authErr) return authErrorResponse(authErr);

  const res =
    fmt === "anthropic"
      ? await fetch(`${upstream}/v1/models`, {
          method: "GET",
          headers: anthropicHeaders(request, key!),
        })
      : await fetch(`${upstream}/models`, {
          method: "GET",
          headers: {
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
        });

  if (!res.ok) return upstreamErrorResponse(res, await res.text());

  const url = new URL(request.url);
  if (!isCodexClient(request, url)) {
    return new Response(await res.text(), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const data = (await res.json()) as { data?: { id: string }[] };
  const rawModels = (data.data || []).filter(
    (m) =>
      m.id === "big-pickle" ||
      (m.id.endsWith("-free") && m.id !== "minimax-m3-free"),
  );

  for (const id of Object.keys(KNOWN_MODEL_METADATA)) {
    if (!rawModels.some((m) => m.id === id)) {
      rawModels.push({ id });
    }
  }

  const defaultModel = getDefaultFreeModel();
  if (defaultModel && !rawModels.some((m) => m.id === defaultModel)) {
    rawModels.push({ id: defaultModel });
  }

  const models = rawModels.map((m) => buildCodexModelEntry(m.id));

  if (route.path.startsWith("/v1/models/")) {
    const modelId = route.path.split("/").pop()!;
    const matched = models.find((m) => m.slug === modelId);
    return jsonResponse(matched ?? buildCodexModelEntry(modelId));
  }

  return jsonResponse({ models });
}
