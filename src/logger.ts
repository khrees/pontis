declare const process: { env?: Record<string, string | undefined> };

export function isDebug(): boolean {
  return typeof process !== "undefined" && process.env?.PONTIS_DEBUG === "true";
}

export function debugLog(...args: unknown[]): void {
  if (isDebug()) console.log(...args);
}

export function warnLog(...args: unknown[]): void {
  console.warn(...args);
}
