import { isDebug } from "./env";

export { isDebug };

export function debugLog(...args: unknown[]): void {
  if (isDebug()) console.log(...args);
}

export function warnLog(...args: unknown[]): void {
  console.warn(...args);
}
