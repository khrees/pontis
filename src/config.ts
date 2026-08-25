import {
  getProvider,
  getModel,
  getUpstreamUrl,
  getUpstreamFormat,
  isCodexMode,
  getGoUpstream,
  getZenUpstream,
  getEnv,
} from "./env";
import { extractApiKey, validateApiKey } from "./auth";
import { InvalidApiKeyError } from "./errors";
import { isFreeOpenCodeModel } from "./opencode-models";

export const GO_UPSTREAM = getGoUpstream("https://opencode.ai/zen/go/v1");
export const ZEN_UPSTREAM = getZenUpstream("https://opencode.ai/zen/v1");
export const GOOGLE_DEFAULT_UPSTREAM = "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEFAULT_UPSTREAM = GO_UPSTREAM;
export const VISION_MODEL = "qwen3.6-plus";

export function getVisionModel(): string {
  const custom = getEnv("PONTIS_VISION_MODEL");
  if (custom) return custom;
  if (getProvider() === "cloudflare") {
    return "@cf/meta/llama-3.2-11b-vision-instruct";
  }
  if (getProvider() === "google") {
    return "gemini-3.6-flash";
  }
  return VISION_MODEL;
}

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
  "grok",
  "kimi",
  "glm",
  "hy3",
  "laguna",
  "muse",
  "ox",
];

export type RouteConfig = {
  path: string;
  upstream: string;
  modelOverride: string | null;
};

export function getDefaultFreeModel(): string {
  const model = getModel();
  if (model) return model;
  if (getProvider() === "cloudflare") {
    return "@cf/moonshotai/kimi-k2.6";
  }
  if (getProvider() === "local") {
    return "llama3";
  }
  if (getProvider() === "google") {
    return "gemini-3.6-flash";
  }
  return "mimo-v2.5-free";
}

export function resolveModel(model: string): string {
  const defaultFreeModel = getDefaultFreeModel();
  if (!model) return defaultFreeModel;

  const lower = model.toLowerCase();
  if (lower.startsWith("@cf/") || lower.startsWith("gemini-") || lower.startsWith("gemma-")) {
    return model;
  }

  // Known OpenCode model prefixes — pass through unchanged regardless of -free suffix.
  // The upstream decides access based on the API key tier; we must not downgrade paid
  // model IDs (e.g. deepseek-v4-flash) to free equivalents (deepseek-v4-flash-free).
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
  const defaultUp = getProvider() === "google" ? GOOGLE_DEFAULT_UPSTREAM : DEFAULT_UPSTREAM;
  return { path: remaining, upstream: defaultUp, modelOverride: model };
}

export function getUpstream(routeUpstream: string): string {
  const target = getUpstreamUrl();
  if (target) return target;
  if (getProvider() === "google") return GOOGLE_DEFAULT_UPSTREAM;
  return routeUpstream;
}

export function upstreamFormat(): "openai" | "anthropic" | "openai-completions" {
  const fmt = getUpstreamFormat();

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
  const targetUpstream = getUpstreamUrl();
  if (targetUpstream) return targetUpstream;

  const provider = getProvider();
  if (provider === "google") {
    return GOOGLE_DEFAULT_UPSTREAM;
  }

  const path = new URL(request.url).pathname;
  if (path.startsWith("/go")) return GO_UPSTREAM;
  if (path.startsWith("/zen")) return ZEN_UPSTREAM;

  if (routeUpstream.includes("opencode.ai")) {
    return isFreeOpenCodeModel(model) ? ZEN_UPSTREAM : GO_UPSTREAM;
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
    isCodexMode()
  );
}

export interface ResolvedModel {
  model: string;
  upstream: string;
  authErr: ReturnType<typeof import("./auth").validateApiKey>;
}

export function requestHasImages(messages: { content?: unknown }[] | undefined): boolean {
  return (messages || []).some(
    (msg) =>
      Array.isArray(msg.content) &&
      msg.content.some((part: any) => part?.type === "image"),
  );
}

export function resolveModelAndUpstream(
  request: Request,
  routeUpstream: string,
  model: string,
  options?: { hasVision?: boolean },
): ResolvedModel {
  const key = extractApiKey(request.headers);
  let resolvedModel = model;
  const baseUpstream = getUpstream(routeUpstream);
  const provider = getProvider();
  const isGoogle = provider === "google" || baseUpstream.includes("googleapis.com");
  const isCloudflare = provider === "cloudflare" || baseUpstream.includes("gateway.ai.cloudflare.com");
  const isLocal = provider === "local" || baseUpstream.includes("localhost") || baseUpstream.includes("127.0.0.1");
  const isOpencode = !isGoogle && !isCloudflare && !isLocal && (provider === "opencode" || baseUpstream.includes("opencode.ai"));

  if (isOpencode || isCloudflare || isGoogle) {
    resolvedModel = resolveModel(resolvedModel);
    if (options?.hasVision) {
      resolvedModel = getVisionModel();
    }
  }

  const upstream = selectUpstream(request, routeUpstream, resolvedModel);
  let authErr = null;
  if (isOpencode) {
    authErr = validateApiKey(key);
  } else if (isCloudflare || isGoogle) {
    if (!key) {
      throw new InvalidApiKeyError("Missing API key. Provide x-api-key or Authorization header.");
    }
  }
  return { model: resolvedModel, upstream, authErr };
}
