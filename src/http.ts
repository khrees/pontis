import { warnLog } from "./logger";
import { getTimeoutMs } from "./env";
import {
  UpstreamTimeoutError,
  UpstreamConnectionError,
  errorToResponse,
} from "./errors";
import { isFreeOpenCodeModel } from "./opencode-models";

/**
 * OpenCode client version to present in User-Agent for free-tier gate.
 * The gateway requires User-Agent matching `opencode/<version>` with version >= 1.17.0.
 */
export const OPENCODE_CLIENT_VERSION = "1.18.31";

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let result = "";
  for (let i = 0; i < length; i++) {
    result += BASE62_CHARS[bytes[i] % 62];
  }
  return result;
}

/**
 * Generate a canonical OpenCode session ID: `ses_<12 hex chars><14 base62 chars>`.
 * The 12 hex chars encode a descending timestamp; the 14 base62 chars are random.
 */
export function generateCanonicalSessionId(): string {
  const ts = Date.now();
  const hex = ts.toString(16).padStart(12, "0").slice(-12);
  return `ses_${hex}${randomBase62(14)}`;
}

/**
 * Generate a canonical OpenCode message/request ID: `msg_<12 hex><14 base62>`.
 */
export function generateMessageId(): string {
  const ts = Date.now();
  const hex = ts.toString(16).padStart(12, "0").slice(-12);
  return `msg_${hex}${randomBase62(14)}`;
}

/** Validate if a session ID already matches the canonical format. */
const CANONICAL_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

const PASSTHROUGH_ERROR_HEADERS = [
  "Content-Type",
  "Retry-After",
  "RateLimit-Limit",
  "RateLimit-Remaining",
  "RateLimit-Reset",
] as const;

let requestCounter = 0;

export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${(++requestCounter % 65536).toString(36)}`;
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const timeoutMs = options.timeout ?? getTimeoutMs(120000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const callerSignal = options.signal;
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException("The operation was aborted", "AbortError");
    }
    callerSignal.addEventListener(
      "abort",
      () => controller.abort(callerSignal.reason),
      { once: true },
    );
  }

  const retries = options.method && options.method !== "POST" ? 0 : 2;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") {
        clearTimeout(timeoutId);
        throw new UpstreamTimeoutError(timeoutMs);
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  clearTimeout(timeoutId);
  let host = "";
  try {
    host = new URL(url).host;
  } catch {}
  const detail = lastError instanceof Error ? lastError.message : "Unknown connection error";
  throw new UpstreamConnectionError(
    host ? `Could not reach ${host} (${detail}). Check network/DNS and retry.` : detail
  );
}

export function anthropicHeaders(
  request: Request,
  key: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": key,
    "Anthropic-Version":
      request.headers.get("Anthropic-Version") || "2023-06-01",
  };
  const beta = request.headers.get("Anthropic-Beta");
  if (beta) headers["Anthropic-Beta"] = beta;
  return headers;
}

let defaultProxySessionId: string | null = null;

export function getOrCreateSessionId(incomingRequest?: Request): string {
  if (incomingRequest) {
    const fromHeader =
      incomingRequest.headers.get("x-opencode-session") ||
      incomingRequest.headers.get("x-session-id") ||
      incomingRequest.headers.get("session-id");
    if (fromHeader) {
      // If already canonical, use as-is; otherwise canonicalize it
      if (CANONICAL_SESSION_RE.test(fromHeader)) return fromHeader;
      // Generate a deterministic canonical session from the incoming ID
      return canonicalizeSessionId(fromHeader);
    }
  }
  if (!defaultProxySessionId) {
    defaultProxySessionId = generateCanonicalSessionId();
  }
  return defaultProxySessionId;
}

/**
 * Convert an arbitrary session string to canonical ses_ format deterministically.
 * Uses a simple hash of the input to produce stable hex + base62 components.
 */
function canonicalizeSessionId(raw: string): string {
  // Simple FNV-1a-like hash for determinism
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 = ((h1 ^ c) * 0x01000193) >>> 0;
    h2 = ((h2 ^ c) * 0x811c9dc5) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
  // Derive base62 portion from the hash values
  let b62 = "";
  let val = (h1 * 65537 + h2) >>> 0;
  for (let i = 0; i < 14; i++) {
    val = ((val * 1103515245 + 12345) >>> 0);
    b62 += BASE62_CHARS[val % 62];
  }
  return `ses_${hex}${b62}`;
}

let defaultProxyProjectId: string | null = null;

export function getOrCreateProjectId(incomingRequest?: Request): string {
  if (incomingRequest) {
    const fromHeader = incomingRequest.headers.get("x-opencode-project");
    if (fromHeader) return fromHeader;
  }
  if (!defaultProxyProjectId) {
    try {
      const cwd = typeof process !== "undefined" ? process.cwd() : "pontis-project";
      let h1 = 0x811c9dc5 >>> 0;
      let h2 = 0x01000193 >>> 0;
      for (let i = 0; i < cwd.length; i++) {
        const c = cwd.charCodeAt(i);
        h1 = ((h1 ^ c) * 0x01000193) >>> 0;
        h2 = ((h2 ^ c) * 0x811c9dc5) >>> 0;
      }
      defaultProxyProjectId = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(3).slice(0, 40);
    } catch {
      defaultProxyProjectId = "bacdc472095e2c29d5ce6c2ee144f8d6f86dced8";
    }
  }
  return defaultProxyProjectId;
}

export function openaiAuthHeaders(
  key: string | null,
  upstream?: string,
  incomingRequest?: Request,
  model?: string,
): Record<string, string> {
  const isDummy = !key || key === "pontis" || key === "dummy";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(!isDummy ? { Authorization: `Bearer ${key}` } : {}),
  };

  const isOpenCode =
    (upstream && upstream.includes("opencode.ai")) ||
    (typeof process !== "undefined" && process.env?.PONTIS_PROVIDER === "opencode");

  if (isOpenCode) {
    const sessionId = getOrCreateSessionId(incomingRequest);
    headers["x-opencode-session"] = sessionId;
    headers["x-opencode-project"] = getOrCreateProjectId(incomingRequest);

    // For free-tier models, we must present as the native OpenCode client
    const isFreeTier = model ? isFreeOpenCodeModel(model) : false;

    if (isFreeTier) {
      headers["User-Agent"] = `opencode/${OPENCODE_CLIENT_VERSION}`;
      headers["x-opencode-client"] = "desktop";

      // The free-tier gateway recognizes the native client by the literal
      // credential `public` (mirrors CLI: `options.apiKey = "public"`).
      // It never applies to paid models, so a real key is never masked.
      headers["Authorization"] = "Bearer public";
    } else {
      const client =
        incomingRequest?.headers.get("x-opencode-client") ||
        (typeof process !== "undefined" ? process.env?.PONTIS_CLIENT : undefined) ||
        "pontis";
      headers["x-opencode-client"] = client;
    }

    headers["x-opencode-request"] = generateMessageId();
  }

  return headers;
}

export function upstreamErrorResponse(
  res: Response,
  body: string,
  requestId?: string,
): Response {
  const headers = new Headers();
  for (const name of PASSTHROUGH_ERROR_HEADERS) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (requestId) headers.set("X-Request-Id", requestId);
  headers.set("Content-Type", "application/json");
  let safeBody = body;
  try {
    JSON.parse(body);
  } catch {
    safeBody = JSON.stringify({
      error: { type: "upstream_error", message: body.slice(0, 2000) },
    });
  }
  return new Response(safeBody, { status: res.status, headers });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function wrapProxyRequest(
  reqId: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    warnLog(`[${reqId}] Request failed: ${err instanceof Error ? err.message : String(err)}`);
    return errorToResponse(err, reqId);
  }
}

export function passthroughResponse(res: Response): Response {
  const headers: Record<string, string> = {
    "Content-Type": res.headers.get("Content-Type") || "application/json",
  };
  const cacheControl = res.headers.get("Cache-Control");
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  const connection = res.headers.get("Connection");
  if (connection) headers["Connection"] = connection;
  return new Response(res.body, { status: res.status, headers });
}
