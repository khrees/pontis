/**
 * Redact a sensitive token / API key for display purposes.
 * Shows the first 4 and last 4 characters, replacing the middle with •••.
 * Very short values are fully masked.
 */
export function redactKey(value: string | undefined | null): string {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return value.slice(0, 4) + "•••" + value.slice(-4);
}
