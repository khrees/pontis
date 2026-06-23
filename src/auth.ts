declare const process: { env?: Record<string, string | undefined> };

/**
 * API key extraction and validation.
 *
 * Minimum key length can be configured via PONTIS_MIN_KEY_LENGTH env var.
 * Defaults to 32 for OpenCode. Set to 0 to disable length checks (local models).
 */

export function getMinKeyLength(): number {
  const val = process?.env?.PONTIS_MIN_KEY_LENGTH;
  if (val === undefined || val === "") return 32;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : 32;
}

export function extractApiKey(headers: Headers | Record<string, string | null>): string | null {
  const get = (name: string) => {
    if (headers instanceof Headers) return headers.get(name);
    return (headers as Record<string, string | null>)[name.toLowerCase()] || null;
  };
  return get("X-Api-Key") || get("Authorization")?.replace("Bearer ", "")?.trim() || null;
}

export interface AuthError {
  status: number;
  body: Record<string, unknown>;
}

export function validateApiKey(key: string | null): AuthError | null {
  if (!key) {
    return {
      status: 401,
      body: { error: { type: "authentication_error", message: "Missing API key. Provide x-api-key header." } },
    };
  }
  const minLength = getMinKeyLength();
  if (minLength > 0 && key.length < minLength) {
    return {
      status: 401,
      body: { error: { type: "authentication_error", message: `API key is too short. Must be at least ${minLength} characters.` } },
    };
  }
  return null;
}

export function authErrorResponse(err: AuthError): Response {
  return new Response(JSON.stringify(err.body), {
    status: err.status,
    headers: { "Content-Type": "application/json" },
  });
}
