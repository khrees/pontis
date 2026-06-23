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

export function upstreamErrorResponse(res: Response, body: string): Response {
  const headers = new Headers();
  for (const name of PASSTHROUGH_ERROR_HEADERS) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(body, { status: res.status, headers });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
