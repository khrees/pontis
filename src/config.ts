declare const process: { env?: Record<string, string | undefined> };

import { extractApiKey, validateApiKey } from "./auth";

export const GO_UPSTREAM = "https://opencode.ai/zen/go/v1";
export const ZEN_UPSTREAM = "https://opencode.ai/zen/v1";
export const DEFAULT_UPSTREAM = GO_UPSTREAM;
export const VISION_MODEL = "qwen3.6-plus";

const API_START_PATHS = new Set(["v1", "v2"]);

const KNOWN_OPENCODE_PREFIXES = [
  "mimo",
  "deepseek",
  "big-pickle",
  "nemotron",
  "qwen",
  "llama",
  "mistral",
  "gemma",
  "phi",
  "starcoder",
  "codestral",
  "command",
  "minimax",
  "north",
];

const PAID_TO_FREE: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-v4-flash-free",
  "mimo-v2.5": "mimo-v2.5-free",
  "nemotron-3-ultra": "nemotron-3-ultra-free",
  "north-mini-code": "north-mini-code-free",
};

const PREFIX_TO_FREE: [string, string][] = [
  ["deepseek", "deepseek-v4-flash-free"],
  ["mimo", "mimo-v2.5-free"],
  ["nemotron", "nemotron-3-ultra-free"],
  ["north", "north-mini-code-free"],
];

export type RouteConfig = {
  path: string;
  upstream: string;
  modelOverride: string | null;
};

export function getDefaultFreeModel(): string {
  return process?.env?.PONTIS_MODEL || "mimo-v2.5-free";
}

export function resolveModel(model: string): string {
  const defaultFreeModel = getDefaultFreeModel();
  if (!model) return defaultFreeModel;

  const lower = model.toLowerCase();
  if (PAID_TO_FREE[lower]) return PAID_TO_FREE[lower];

  for (const [prefix, freeModel] of PREFIX_TO_FREE) {
    if (lower.startsWith(prefix) && !lower.endsWith("-free")) {
      return freeModel;
    }
  }

  if (KNOWN_OPENCODE_PREFIXES.some((p) => lower.startsWith(p))) return model;

  if (
    lower.includes("claude") ||
    lower.includes("haiku") ||
    lower.includes("sonnet") ||
    lower.includes("opus") ||
    lower.includes("gpt")
  ) {
    return defaultFreeModel;
  }

  return model;
}

function stripPrefix(path: string, prefix: string): string | null {
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return null;
}

function extractModelSegment(path: string): {
  path: string;
  model: string | null;
} {
  const segments = path.replace(/^\/+/, "").split("/");
  if (segments.length > 0 && segments[0] && !API_START_PATHS.has(segments[0])) {
    return { path: "/" + segments.slice(1).join("/"), model: segments[0] };
  }
  return { path, model: null };
}

export function routeConfig(request: Request): RouteConfig {
  const path = new URL(request.url).pathname;
  const goPath = stripPrefix(path, "/go");
  if (goPath) {
    const { path: remaining, model } = extractModelSegment(goPath);
    return { path: remaining, upstream: GO_UPSTREAM, modelOverride: model };
  }

  const zenPath = stripPrefix(path, "/zen");
  if (zenPath) {
    const { path: remaining, model } = extractModelSegment(zenPath);
    return { path: remaining, upstream: ZEN_UPSTREAM, modelOverride: model };
  }

  const { path: remaining, model } = extractModelSegment(path);
  return { path: remaining, upstream: DEFAULT_UPSTREAM, modelOverride: model };
}

export function getUpstream(routeUpstream: string): string {
  return (
    process?.env?.PONTIS_UPSTREAM_URL ||
    routeUpstream
  );
}

export function upstreamFormat(): "openai" | "anthropic" | "openai-completions" {
  const fmt = (
    process?.env?.PONTIS_UPSTREAM_FORMAT ||
    "openai"
  ).toLowerCase();

  if (
    fmt === "openai-completions" ||
    fmt === "openai-codex" ||
    fmt === "codex"
  ) {
    return "openai-completions";
  }
  return fmt === "anthropic" ? "anthropic" : "openai";
}

export function selectUpstream(
  request: Request,
  routeUpstream: string,
  model: string,
): string {
  const targetUpstream = process?.env?.PONTIS_UPSTREAM_URL;
  if (targetUpstream) return targetUpstream;

  const path = new URL(request.url).pathname;
  const hasExplicitPrefix = path.startsWith("/go") || path.startsWith("/zen");
  if (!hasExplicitPrefix && routeUpstream.includes("opencode.ai")) {
    const isFree = model.endsWith("-free") || model === "big-pickle";
    return isFree ? ZEN_UPSTREAM : GO_UPSTREAM;
  }
  return routeUpstream;
}

export function matchesApiPath(
  routePath: string,
  reqUrlPath: string,
  endpoint: string,
): boolean {
  const normalized = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return (
    routePath === `/v1${normalized}` ||
    reqUrlPath === normalized ||
    reqUrlPath === `/v1${normalized}`
  );
}

export function isCodexClient(request: Request, url: URL): boolean {
  return (
    url.searchParams.has("client_version") ||
    (request.headers.get("user-agent") || "").toLowerCase().includes("codex") ||
    (request.headers.get("user-agent") || "").toLowerCase().includes("openai") ||
    process?.env?.PONTIS_CODEX_MODE === "true"
  );
}

// ──────────────────────────────────────────────
//  Model resolution helpers (used by index.ts)
// ──────────────────────────────────────────────

export interface ResolvedModel {
  model: string;
  upstream: string;
  authErr: ReturnType<typeof import("./auth").validateApiKey>;
}

/** Check if an Anthropic request body contains image content blocks. */
export function requestHasImages(messages: { content?: unknown }[] | undefined): boolean {
  return (messages || []).some(
    (msg) =>
      Array.isArray(msg.content) &&
      msg.content.some((part: any) => part?.type === "image"),
  );
}

/** Resolve model + upstream + auth for a request, applying vision fallback for OpenCode. */
export function resolveModelAndUpstream(
  request: Request,
  routeUpstream: string,
  model: string,
  options?: { hasVision?: boolean },
): ResolvedModel {
  const key = extractApiKey(request.headers);
  let resolvedModel = model;
  const baseUpstream = getUpstream(routeUpstream);

  if (baseUpstream.includes("opencode.ai")) {
    resolvedModel = resolveModel(resolvedModel);
    if (options?.hasVision) {
      resolvedModel = VISION_MODEL;
    }
  }

  const upstream = selectUpstream(request, routeUpstream, resolvedModel);
  const authErr = upstream.includes("opencode.ai") ? validateApiKey(key) : null;
  return { model: resolvedModel, upstream, authErr };
}
