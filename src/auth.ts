import { getMinKeyLength } from "./env";
import { InvalidApiKeyError, ApiKeyLengthError, errorToResponse } from "./errors";

export { getMinKeyLength };

export function extractApiKey(headers: Headers | Record<string, string | null>): string | null {
  const get = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    const lowerName = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lowerName) {
        return (headers as Record<string, string | null>)[key] || null;
      }
    }
    return null;
  };
  const xApiKey = get("x-api-key");
  if (xApiKey) return xApiKey;

  const auth = get("authorization");
  if (auth) {
    return auth.replace(/^bearer\s+/i, "").trim() || null;
  }

  const googApiKey = get("x-goog-api-key");
  if (googApiKey) return googApiKey;

  return null;
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
