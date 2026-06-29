declare const process: { env?: Record<string, string | undefined> };

import { warnLog } from "./logger";
import {
  UpstreamTimeoutError,
  UpstreamConnectionError,
  errorToResponse,
  UpstreamError,
} from "./errors";

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

/** Generate a short, human-readable request ID for tracing. */
export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${(++requestCounter % 65536).toString(36)}`;
}

/** Read an env var with a fallback. */
function getEnv(name: string, fallback = ""): string {
  return process?.env?.[name] || fallback;
}

/**
 * Fetch with a configurable timeout.
 *
 * Defaults to 120s. Override via `PONTIS_TIMEOUT_MS` env var or the `timeout` option.
 * Composes with any caller-provided AbortSignal.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const timeoutMs = options.timeout ?? parseInt(getEnv("PONTIS_TIMEOUT_MS", "120000"), 10);
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

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new UpstreamTimeoutError(timeoutMs);
    }
    throw new UpstreamConnectionError(
      error instanceof Error ? error.message : "Unknown connection error"
    );
  } finally {
    clearTimeout(timeoutId);
  }
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

export function openaiAuthHeaders(key: string | null): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

/** Pass through an upstream error response, preserving relevant headers. */
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
  // Always return JSON to prevent reflected XSS from HTML error pages
  headers.set("Content-Type", "application/json");
  let safeBody = body;
  try {
    JSON.parse(body); // validate it's already JSON
  } catch {
    // Wrap non-JSON error bodies to prevent XSS
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

/**
 * Wraps a proxy request handler with standard error handling.
 * Catches AbortError (timeout) and generic errors, returning appropriate error responses.
 */
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

/**
 * Build a passthrough response preserving key headers from the upstream.
 * Used when no format translation is needed (same-format proxying).
 */
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
