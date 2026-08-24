import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  retrieveOpenCodeApiKey,
  retrieveCloudflareApiToken,
  storeCloudflareApiToken,
  retrieveLocalApiKey,
  retrieveGoogleApiKey,
} from "../secure-storage";
import {
  getPreferences,
  getPontisDir,
  type PontisPreferences,
  type ProviderType,
} from "./preferences";

const __CLI_DIR = dirname(fileURLToPath(import.meta.url));
// In dev mode (tsx running src/cli/index.ts), ROOT is the project root (parent of src/).
// In installed/bundled mode, ROOT is the script's own directory.
export const ROOT = existsSync(join(dirname(dirname(__CLI_DIR)), "package.json"))
  ? dirname(dirname(__CLI_DIR))
  : dirname(__CLI_DIR);

export const PONTIS_DIR = getPontisDir();
export const PROXY_LOG = join(PONTIS_DIR, "proxy.log");
export const CACHE_FILE = join(PONTIS_DIR, "models_cache.json");
export const DIST_PROXY = join(ROOT, "dist", "proxy.js");
export const SRC_DIR = join(ROOT, "src");
export const CLOUDFLARE_CONFIG_FILE = join(PONTIS_DIR, "cloudflare.json");

export const GOOGLE_DEFAULT_UPSTREAM = "https://generativelanguage.googleapis.com/v1beta/openai";

export const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
export const PI_MODELS_FILE = join(PI_AGENT_DIR, "models.json");

// Client tools managed by Pontis install engine
export const CLIENTS_DIR = join(PONTIS_DIR, "clients");

// OpenCode data directory (managed by OpenCode itself, but we write auth entries)
export const OPENCODE_DATA_DIR = join(homedir(), ".local", "share", "opencode");
export const OPENCODE_AUTH_FILE = join(OPENCODE_DATA_DIR, "auth.json");

export interface PontisEnv {
  clientCmd?: string;
  model?: string;
  provider?: "opencode" | "local" | "cloudflare" | "google";
  apiKey?: string;
  upstreamUrl?: string;
  upstreamFormat?: string;
}

/** Parse a string into a known provider, or null if unrecognized. */
export function normalizeProvider(value?: string | null): ProviderType | null {
  if (!value) return null;
  const lower = value.toLowerCase().trim();
  if (lower === "opencode" || lower === "cloudflare" || lower === "local" || lower === "google") {
    return lower;
  }
  if (lower === "gemini") {
    return "google";
  }
  return null;
}

export function getCloudflareConfigSaved(): { apiToken?: string; accountId?: string; gatewayId?: string } {
  // Try secure storage first for the token
  const secureApiToken = retrieveCloudflareApiToken();

  // Legacy file may have accountId/gatewayId (and, in older versions, the token)
  let legacy: Record<string, string | undefined> = {};
  if (existsSync(CLOUDFLARE_CONFIG_FILE)) {
    try {
      legacy = JSON.parse(readFileSync(CLOUDFLARE_CONFIG_FILE, "utf-8"));
    } catch {}
  }

  // Migrate a legacy plaintext token into the encrypted vault and scrub it
  // from the on-disk file so the token is never stored in plaintext.
  if (legacy.apiToken) {
    try {
      if (!secureApiToken) storeCloudflareApiToken(legacy.apiToken);
      const { apiToken: _omit, ...rest } = legacy;
      writeFileSync(CLOUDFLARE_CONFIG_FILE, JSON.stringify(rest, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
    } catch {}
  }

  // Merge: prefer token from secure storage, take accountId/gatewayId from file
  return {
    apiToken: secureApiToken || legacy.apiToken,
    accountId: legacy.accountId,
    gatewayId: legacy.gatewayId,
  };
}

export function getLocalApiKey(): string {
  // Try secure storage first
  const secureKey = retrieveLocalApiKey();
  if (secureKey) {
    return secureKey;
  }
  
  // Fall back to environment variables
  return (
    process.env.LOCAL_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "local-model-dummy-api-key-value-32-chars-long"
  );
}

export function getGoogleApiKey(): string | null {
  return (
    retrieveGoogleApiKey() ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    null
  );
}

export function getGoogleAuthToken(): string | null {
  return getGoogleApiKey();
}

export function getDefaultModelForProvider(provider?: ProviderType | string | null): string {
  switch (provider) {
    case "cloudflare":
      return "@cf/moonshotai/kimi-k2.6";
    case "local":
      return "llama3";
    case "google":
      return "gemini-2.5-flash";
    case "opencode":
    default:
      return "mimo-v2.5-free";
  }
}

export function getProviderDisplayName(provider?: ProviderType | string | null): string {
  switch (provider) {
    case "cloudflare":
      return "Cloudflare AI Gateway";
    case "local":
      return "Local";
    case "google":
      return "Google (Gemini)";
    case "opencode":
    default:
      return "OpenCode";
  }
}

export interface ResolvedConfig {
  provider: ProviderType;
  model: string;
}

export interface ResolveInput {
  /** Explicit per-invocation values (CLI flags). */
  provider?: string | null;
  model?: string | null;
  upstream?: string | null;
  /** Environment overrides (PONTIS_PROVIDER / PONTIS_MODEL / PONTIS_UPSTREAM_URL). */
  envProvider?: string | null;
  envModel?: string | null;
  envUpstream?: string | null;
  /** Standing user preferences (~/.pontis/preferences.json). */
  prefs: PontisPreferences;
  /** Credential detection fallbacks. */
  hasOpenCodeKey: boolean;
  hasCloudflareConfig: boolean;
  hasGoogleKey?: boolean;
}

const OPENCODE_SPECIFIC_MODELS = new Set([
  "mimo-v2.5-free",
  "deepseek-v4-flash-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3-ultra-free",
  "hy3-free",
  "laguna-s-2.1-free",
  "qwen3.6-plus",
  "qwen3.7-plus",
  "kimi-k3",
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "glm-5.2",
  "grok-4.6",
  "grok-4.5",
  "gemini-3.7-flash",
]);

/**
 * Check if a model string is compatible with a given provider.
 * Prevents cross-provider model bleed (e.g. @cf/... sent to OpenCode, mimo-... sent to Local).
 */
export function isModelCompatibleWithProvider(
  model: string | undefined | null,
  provider: ProviderType,
): boolean {
  if (!model) return false;
  if (provider === "cloudflare") {
    return model.startsWith("@cf/");
  }
  if (provider === "google") {
    return model.startsWith("gemini-") || model.startsWith("gemma-");
  }
  if (provider === "opencode") {
    return !model.startsWith("@cf/") && !model.startsWith("http://") && !model.startsWith("https://");
  }
  if (provider === "local") {
    return !model.startsWith("@cf/") && !model.endsWith("-free") && !OPENCODE_SPECIFIC_MODELS.has(model);
  }
  return true;
}

/**
 * Resolve the active provider and model from explicit input, environment,
 * preferences, and detected credentials — in that order of precedence.
 * Pure function: no I/O, no env access, no guessing from model names.
 */
export function resolveProviderAndModel(input: ResolveInput): ResolvedConfig {
  const { prefs } = input;
  const lastUsed = prefs.lastUsed;

  const provider: ProviderType =
    normalizeProvider(input.provider) ??
    normalizeProvider(input.envProvider) ??
    (input.upstream || input.envUpstream ? "local" : null) ??
    normalizeProvider(prefs.defaultProvider) ??
    normalizeProvider(lastUsed?.provider) ??
    (input.hasGoogleKey ? "google" : null) ??
    (input.hasOpenCodeKey ? "opencode" : null) ??
    (input.hasCloudflareConfig ? "cloudflare" : null) ??
    (prefs.localEndpoint ? "local" : null) ??
    "opencode";

  const model =
    input.model ||
    input.envModel ||
    (prefs.providerModels?.[provider] && isModelCompatibleWithProvider(prefs.providerModels[provider], provider)
      ? prefs.providerModels[provider]
      : undefined) ||
    (prefs.defaultModel && isModelCompatibleWithProvider(prefs.defaultModel, provider)
      ? prefs.defaultModel
      : undefined) ||
    (lastUsed?.provider === provider && lastUsed.model && isModelCompatibleWithProvider(lastUsed.model, provider)
      ? lastUsed.model
      : undefined) ||
    getDefaultModelForProvider(provider);

  return { provider, model };
}

export function resolveActiveProviderAndModel(options?: {
  provider?: string;
  model?: string;
  upstream?: string;
}): ResolvedConfig {
  const savedCf = getCloudflareConfigSaved();
  return resolveProviderAndModel({
    provider: options?.provider,
    model: options?.model,
    upstream: options?.upstream,
    envProvider: process.env.PONTIS_PROVIDER,
    envModel: process.env.PONTIS_MODEL,
    envUpstream: process.env.PONTIS_UPSTREAM_URL,
    prefs: getPreferences(),
    hasGoogleKey: !!getGoogleAuthToken(),
    hasOpenCodeKey: !!getOpenCodeApiKey(),
    hasCloudflareConfig: !!(savedCf.apiToken && savedCf.accountId),
  });
}

// Function to get OpenCode API key
export function getOpenCodeApiKey(): string | null {
  return retrieveOpenCodeApiKey() || process.env.OPENCODE_API_KEY || null;
}
