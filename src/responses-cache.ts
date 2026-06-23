/**
 * LRU conversation state cache for the Responses API.
 *
 * The Responses API uses `previous_response_id` for multi-turn conversations.
 * The client sends only *new* input on each turn; the server is expected to
 * remember prior output and reconstruct the full context.
 *
 * This cache stores the translated Chat Completions message list from each
 * response. When a follow-up request arrives with a `previous_response_id`,
 * the stored messages are prepended so the upstream model sees the complete
 * conversation history.
 */

export interface CachedTurn {
  /** The response ID this turn produced. */
  responseId: string;
  /** Model name sent to the upstream. */
  model: string;
  /** Original model name from the client (before remapping). */
  originalModel: string;
  /** Complete Chat Completions messages array after this turn. */
  fullMessages: unknown[];
  /** Usage metadata from the upstream response. */
  usage: Record<string, number>;
  /** When this entry was created (ms epoch). */
  createdAt: number;
}

export class ResponsesCache {
  private cache: Map<string, CachedTurn>;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 50, ttlMs = 5 * 60 * 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(id: string): CachedTurn | undefined {
    const entry = this.cache.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(id);
      return undefined;
    }
    // LRU: move to end on access
    this.cache.delete(id);
    this.cache.set(id, entry);
    return entry;
  }

  set(id: string, entry: Omit<CachedTurn, "createdAt">): void {
    // Evict stale entries
    const now = Date.now();
    for (const [key, val] of this.cache) {
      if (now - val.createdAt > this.ttlMs) {
        this.cache.delete(key);
      }
    }
    // Evict LRU if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(id, { ...entry, createdAt: now });
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /** Current number of cached entries (for diagnostics). */
  get size(): number {
    return this.cache.size;
  }

  /** List cached response IDs from newest to oldest. */
  keys(): string[] {
    return [...this.cache.keys()].reverse();
  }
}

// ---------------------------------------------------------------------------
// Singleton shared across requests
// ---------------------------------------------------------------------------

export const responseCache = new ResponsesCache();
