/**
 * Centralized environment variable access.
 *
 * Cloudflare Workers do not provide `process.env`, so all access goes through
 * typed helpers with optional chaining and sensible defaults. The `declare`
 * lives in this single module so every other file can import safe accessors
 * instead of scattering `declare const process` across the codebase.
 */

declare const process: { env?: Record<string, string | undefined> };

// ── Generic accessors ──

/** Read a string env var. Returns `fallback` when unset or empty. */
export function getEnv(name: string, fallback = ""): string {
  return process?.env?.[name] || fallback;
}

/** Read a number env var. Returns `fallback` when unset, empty, or NaN. */
export function getEnvAsNumber(
  name: string,
  fallback: number,
  min?: number,
): number {
  const val = process?.env?.[name];
  if (val === undefined || val === "") return fallback;
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  return n;
}

/** Read a boolean env var (true when value is the string "true"). */
export function getEnvAsBoolean(name: string): boolean {
  return process?.env?.[name] === "true";
}

// ── Named accessors for Pontis env vars ──

export function getProvider(): string {
  return (process?.env?.PONTIS_PROVIDER || "").toLowerCase();
}

export function getModel(): string {
  return process?.env?.PONTIS_MODEL || "";
}

export function getUpstreamUrl(): string {
  return process?.env?.PONTIS_UPSTREAM_URL || "";
}

export function getUpstreamFormat(): string {
  return (process?.env?.PONTIS_UPSTREAM_FORMAT || "openai").toLowerCase();
}

export function getMinKeyLength(): number {
  const val = process?.env?.PONTIS_MIN_KEY_LENGTH;
  if (val === undefined || val === "") return 32;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : 32;
}

export function isCodexMode(): boolean {
  return process?.env?.PONTIS_CODEX_MODE === "true";
}

export function getTimeoutMs(fallback = 120000): number {
  const val = process?.env?.PONTIS_TIMEOUT_MS;
  if (val === undefined || val === "") return fallback;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 1000 ? n : fallback;
}

/** Check whether the global `process` object exists (it won't in Workers). */
export function hasProcess(): boolean {
  return typeof process !== "undefined";
}

// ── Debug helpers ──

export function isDebug(): boolean {
  return hasProcess() && process.env?.PONTIS_DEBUG === "true";
}
