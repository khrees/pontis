/**
 * API key extraction and validation.
 *
 * Minimum key length can be configured via PONTIS_MIN_KEY_LENGTH env var.
 * Defaults to 32 for OpenCode. Set to 0 to disable length checks (local models).
 */

import { getMinKeyLength } from "./env";
import { InvalidApiKeyError, ApiKeyLengthError, errorToResponse } from "./errors";

export { getMinKeyLength };

export function extractApiKey(headers: Headers | Record<string, string | null>): string | null {
  const get = (name: string) => {
    if (headers instanceof Headers) return headers.get(name);
    return (headers as Record<string, string | null>)[name.toLowerCase()] || null;
  };
  return get("X-Api-Key") || get("Authorization")?.replace("Bearer ", "")?.trim() || null;
}

export function validateApiKey(key: string | null): null | never {
  if (!key) {
    throw new InvalidApiKeyError("Missing API key. Provide x-api-key header.");
  }
  const minLength = getMinKeyLength();
  if (minLength > 0 && key.length < minLength) {
    throw new ApiKeyLengthError(minLength, key.length);
  }
  return null;
}

export function authErrorResponse(error: unknown, requestId?: string): Response {
  return errorToResponse(error, requestId);
}
