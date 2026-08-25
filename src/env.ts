declare const process: { env?: Record<string, string | undefined> } | undefined;

function getRawEnv(name: string): string | undefined {
  if (typeof process !== "undefined" && process?.env) {
    return process.env[name];
  }
  return undefined;
}

export function getEnv(name: string, fallback = ""): string {
  return getRawEnv(name) || fallback;
}

export function getEnvAsNumber(
  name: string,
  fallback: number,
  min?: number,
): number {
  const val = getRawEnv(name);
  if (val === undefined || val === "") return fallback;
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  return n;
}

export function getEnvAsBoolean(name: string): boolean {
  return getRawEnv(name) === "true";
}

export function getProvider(): string {
  return (getRawEnv("PONTIS_PROVIDER") || "").toLowerCase();
}

export function getModel(): string {
  return getRawEnv("PONTIS_MODEL") || "";
}

export function getUpstreamUrl(): string {
  return getRawEnv("PONTIS_UPSTREAM_URL") || "";
}

export function getUpstreamFormat(): string {
  return (getRawEnv("PONTIS_UPSTREAM_FORMAT") || "openai").toLowerCase();
}

export function getPort(fallback = 8787): number {
  return getEnvAsNumber("PONTIS_PORT", getEnvAsNumber("PORT", fallback, 1), 1);
}

export function getHost(fallback = "127.0.0.1"): string {
  return getEnv("PONTIS_HOST", fallback);
}

export function getRedirectPort(fallback = 8443): number {
  return getEnvAsNumber("PONTIS_REDIRECT_PORT", fallback, 1);
}

export function getZenUpstream(fallback = "https://opencode.ai/zen/v1"): string {
  return getEnv("PONTIS_ZEN_UPSTREAM", fallback);
}

export function getGoUpstream(fallback = "https://opencode.ai/zen/go/v1"): string {
  return getEnv("PONTIS_GO_UPSTREAM", fallback);
}

export function getMaxBufferBytes(fallback = 5 * 1024 * 1024): number {
  const mb = getEnvAsNumber("PONTIS_MAX_BUFFER_MB", 0);
  if (mb > 0) return mb * 1024 * 1024;
  return getEnvAsNumber("PONTIS_MAX_BUFFER_BYTES", fallback, 1024);
}

export function getChunkSizeBytes(fallback = 64 * 1024): number {
  const kb = getEnvAsNumber("PONTIS_CHUNK_SIZE_KB", 0);
  if (kb > 0) return kb * 1024;
  return getEnvAsNumber("PONTIS_CHUNK_SIZE_BYTES", fallback, 512);
}

export function getCacheMaxTurns(fallback = 50): number {
  return getEnvAsNumber("PONTIS_CACHE_MAX_TURNS", fallback, 1);
}

export function getCacheTtlMs(fallback = 5 * 60 * 1000): number {
  return getEnvAsNumber("PONTIS_CACHE_TTL_MS", fallback, 1000);
}

export function getMinKeyLength(): number {
  const val = getRawEnv("PONTIS_MIN_KEY_LENGTH");
  if (val === undefined || val === "") return 32;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : 32;
}

export function isCodexMode(): boolean {
  return getRawEnv("PONTIS_CODEX_MODE") === "true";
}

export function getTimeoutMs(fallback = 120000): number {
  const val = getRawEnv("PONTIS_TIMEOUT_MS");
  if (val === undefined || val === "") return fallback;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 1000 ? n : fallback;
}

/** Check whether the global `process` object exists (it won't in Workers). */
export function hasProcess(): boolean {
  return typeof process !== "undefined";
}

export function isDebug(): boolean {
  return getRawEnv("PONTIS_DEBUG") === "true";
}
