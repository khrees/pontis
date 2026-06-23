/**
 * LRU conversation state cache for the Responses API.
 *
 * Codex may send `previous_response_id` on follow-up turns. This cache stores
 * translated chat messages so context can be reconstructed when needed.
 */

import type { ResponsesApiUsage } from "./types";

export interface CachedTurn {
  responseId: string;
  model: string;
  originalModel: string;
  fullMessages: unknown[];
  usage: ResponsesApiUsage;
  createdAt: number;
}

export class ResponsesCache {
  private cache = new Map<string, CachedTurn>();

  constructor(
    private readonly maxSize = 50,
    private readonly ttlMs = 5 * 60 * 1000,
  ) {}

  get(id: string): CachedTurn | undefined {
    const entry = this.cache.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(id);
      return undefined;
    }
    this.cache.delete(id);
    this.cache.set(id, entry);
    return entry;
  }

  set(id: string, entry: Omit<CachedTurn, "createdAt">): void {
    const now = Date.now();
    for (const [key, val] of this.cache) {
      if (now - val.createdAt > this.ttlMs) this.cache.delete(key);
    }
    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(id, { ...entry, createdAt: now });
  }

  get size(): number {
    return this.cache.size;
  }

  keys(): string[] {
    return [...this.cache.keys()].reverse();
  }
}

export const responseCache = new ResponsesCache();
