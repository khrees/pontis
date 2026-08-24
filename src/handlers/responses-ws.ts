import type { WebSocket } from "ws";
import type { Hono } from "hono";
import { debugLog, warnLog } from "../logger";

interface CachedResponse {
  id: string;
  model: string;
  status: string;
  output: unknown[];
  usage: Record<string, number>;
}

interface StoredResponse extends CachedResponse {
  storedAt: number;
}

// Keep the in-memory store bounded — unlike the HTTP path's ResponsesCache
// (LRU + TTL), this previously grew without limit on a long-lived server.
const MAX_STORED_RESPONSES = 200;
const RESPONSE_TTL_MS = 5 * 60 * 1000; // 5 minutes, matches the HTTP cache default

const responseStore = new Map<string, StoredResponse>();

function pruneResponseStore(now: number = Date.now()): void {
  // Drop expired entries.
  for (const [id, r] of responseStore) {
    if (now - r.storedAt > RESPONSE_TTL_MS) responseStore.delete(id);
  }
  // Map preserves insertion order — evict oldest beyond the cap.
  while (responseStore.size > MAX_STORED_RESPONSES) {
    const oldest = responseStore.keys().next().value;
    if (oldest === undefined) break;
    responseStore.delete(oldest);
  }
}

/** SSE parser state for bridging HTTP SSE → WebSocket messages. */
class SseParser {
  private buffer = "";

  /** Feed bytes and get back parsed WebSocket events to forward. */
  feed(chunk: string): Record<string, unknown>[] {
    this.buffer += chunk;
    const events: Record<string, unknown>[] = [];

    // SSE is delimited by double newlines
    const parts = this.buffer.split("\n\n");
    // The last part may be incomplete — keep it in the buffer
    this.buffer = parts.pop() || "";

    for (const block of parts) {
      if (!block.trim()) continue;
      const parsed = this.parseBlock(block);
      if (parsed) events.push(parsed);
    }

    return events;
  }

  /** Flush any remaining partial data (when the stream ends). */
  flush(): Record<string, unknown>[] {
    if (!this.buffer.trim()) return [];
    const parsed = this.parseBlock(this.buffer);
    this.buffer = "";
    return parsed ? [parsed] : [];
  }

  private parseBlock(block: string): Record<string, unknown> | null {
    const lines = block.split("\n");
    let dataStr = "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        dataStr = line.slice(6).trim();
      } else if (line.startsWith("id: ")) {
        // event ID — not needed for forwarding
      } else if (line.startsWith("retry: ")) {
        // retry — ignore
      }
    }

    if (!dataStr || dataStr === "[DONE]") return null;

    try {
      const data = JSON.parse(dataStr);
      // Forward the full SSE event as-is (the data JSON already contains the type)
      return data;
    } catch {
      return null;
    }
  }

  reset() {
    this.buffer = "";
  }
}

/** Reconstruct a Web Request from the WebSocket message and ship it to the
 *  Hono app, which routes it to `handleResponsesRequest`. */
async function proxyRequest(
  app: Hono,
  msg: Record<string, unknown>,
  ws: WebSocket,
): Promise<void> {
  const body = JSON.stringify(msg);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  // If Codex didn't include an API key, it'll be picked up from the
  // Authorization header injection in handleResponsesRequest.
  if (process.env.OPENAI_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.OPENAI_API_KEY}`;
  }

  try {
    const req = new Request("http://localhost:8787/v1/responses", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);

    if (!res.ok) {
      const errBody = await res.text();
      const payload: Record<string, unknown> = {
        type: "error",
        code: `http_${res.status}`,
        message: errBody.slice(0, 2000),
      };
      // Include error details that Codex can parse
      try {
        const parsed = JSON.parse(errBody);
        if (parsed.error) payload.error = parsed.error;
      } catch {}
      ws.send(JSON.stringify(payload));
      return;
    }

    // Streaming SSE → WebSocket events
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      const parser = new SseParser();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush any remaining data
            const tail = parser.flush();
            for (const evt of tail) {
              // Store completed responses for response.get
              if (evt.type === "response.completed" && evt.response) {
                const r = evt.response as Record<string, unknown>;
                storeResponse({
                  id: r.id as string,
                  model: r.model as string,
                  status: (r.status as string) || "completed",
                  output: (r.output as unknown[]) || [],
                  usage: (r.usage as Record<string, number>) || {},
                });
              }
              ws.send(JSON.stringify(evt));
            }
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const events = parser.feed(chunk);
          for (const evt of events) {
            // Store completed responses for response.get
            if (evt.type === "response.completed" && evt.response) {
              const r = evt.response as Record<string, unknown>;
              storeResponse({
                id: r.id as string,
                model: r.model as string,
                status: (r.status as string) || "completed",
                output: (r.output as unknown[]) || [],
                usage: (r.usage as Record<string, number>) || {},
              });
            }
            ws.send(JSON.stringify(evt));
          }
        }
      } finally {
        // Always release the upstream stream — a client disconnect that makes
        // ws.send throw must not leave the response body locked/open.
        try { reader.cancel().catch(() => {}); } catch {}
        try { reader.releaseLock(); } catch {}
      }
    } else {
      // Non-streaming response
      const data = await res.json();
      // Wrap in a response.completed event so Codex recognises it
      const respData = data as Record<string, unknown>;
      if (respData.id && respData.object === "response") {
        const completedEvent: Record<string, unknown> = {
          type: "response.completed",
          response: respData,
        };
        // Store for response.get
        storeResponse({
          id: respData.id as string,
          model: respData.model as string,
          status: "completed",
          output: (respData.output as unknown[]) || [],
          usage: (respData.usage as Record<string, number>) || {},
        });
        ws.send(JSON.stringify(completedEvent));
      } else {
        ws.send(JSON.stringify(data));
      }
    }
  } catch (err) {
    warnLog(
      `[WS] Proxy call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    ws.send(
      JSON.stringify({ type: "error", message: "Internal proxy error" }),
    );
  }
}

/**
 * Handle a `response.get` message by returning the cached response data.
 */
function handleResponseGet(ws: WebSocket, msg: Record<string, unknown>): void {
  const responseId = msg.response_id as string;
  if (!responseId) {
    ws.send(JSON.stringify({ type: "error", code: "invalid_request", message: "response_id is required" }));
    return;
  }

  const cached = responseStore.get(responseId);
  if (!cached) {
    ws.send(JSON.stringify({ type: "error", code: "response_not_found", message: `Response ${responseId} not found` }));
    return;
  }

  // Codex expects a response.completed event with the full response payload
  ws.send(JSON.stringify({
    type: "response.completed",
    response: {
      id: cached.id,
      object: "response",
      model: cached.model,
      status: cached.status,
      output: cached.output,
      usage: cached.usage,
    },
  }));
}

/**
 * Handle a `response.delete` message by removing the cached response.
 */
function handleResponseDelete(ws: WebSocket, msg: Record<string, unknown>): void {
  const responseId = msg.response_id as string;
  if (!responseId) {
    ws.send(JSON.stringify({ type: "error", code: "invalid_request", message: "response_id is required" }));
    return;
  }

  const existed = responseStore.has(responseId);
  responseStore.delete(responseId);

  ws.send(JSON.stringify({
    type: "response.deleted",
    response_id: responseId,
    deleted: existed,
  }));
}

/**
 * Handle a `session.update` message. We acknowledge it but don't need
 * to do much since we translate on-the-fly.
 */
function handleSessionUpdate(ws: WebSocket, msg: Record<string, unknown>): void {
  // Acknowledge the session update
  ws.send(JSON.stringify({
    type: "session.updated",
    session: {
      id: msg.id || `sess_${Date.now()}`,
      object: "session",
      ...msg,
    },
  }));
}

/**
 * Create a WebSocket message handler for a given Hono app.
 *
 * Each incoming WebSocket message is expected to be a JSON object from
 * Codex's Responses API WebSocket protocol. We translate and respond.
 */
export function handleWebSocketConnection(
  ws: WebSocket,
  app: Hono,
): void {
  debugLog("[WS] New Responses API WebSocket connection");

  // Send an initial session.created event so Codex knows it's connected
  ws.send(JSON.stringify({
    type: "session.created",
    session: {
      id: `sess_${Date.now()}`,
      object: "session",
      model: "pontis-proxy",
    },
  }));

  ws.on("message", (raw: Buffer | string | ArrayBuffer | Buffer[]) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "invalid_json", message: "Invalid JSON" }));
      return;
    }

    const msgType = (msg.type as string) || "";
    debugLog(`[WS] Received message type: ${msgType}`);

    switch (msgType) {
      case "response.create":
        awaitHandler(proxyRequest(app, msg, ws), ws);
        break;

      case "response.get":
        handleResponseGet(ws, msg);
        break;

      case "response.delete":
        handleResponseDelete(ws, msg);
        break;

      case "session.update":
        handleSessionUpdate(ws, msg);
        break;

      case "ping":
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        break;

      case "pong":
        // Ignore — keepalive response
        break;

      default:
        // For unknown messages, send a graceful error rather than crashing
        debugLog(`[WS] Unhandled message type: ${msgType}`);
        ws.send(
          JSON.stringify({
            type: "error",
            code: "unsupported_message_type",
            message: `Unsupported message type: ${msgType}`,
          }),
        );
        break;
    }
  });

  ws.on("close", () => {
    debugLog("[WS] WebSocket connection closed");
  });

  ws.on("error", (err: Error) => {
    warnLog(`[WS] WebSocket error: ${err.message}`);
  });
}

/** Helper to call an async function inside the sync ws.on("message") callback. */
function awaitHandler(promise: Promise<void>, ws: WebSocket): void {
  promise.catch((err) => {
    warnLog(`[WS] Handler error: ${err instanceof Error ? err.message : String(err)}`);
    try { ws.send(JSON.stringify({ type: "error", code: "handler_error", message: "Handler error" })); } catch {}
  });
}

/**
 * Store a completed response in the in-memory store so it can be
 * retrieved via response.get over WebSocket.
 */
export function storeResponse(response: CachedResponse): void {
  // Refresh recency on re-insert, store with a timestamp, then prune.
  responseStore.delete(response.id);
  responseStore.set(response.id, { ...response, storedAt: Date.now() });
  pruneResponseStore();
}

/**
 * Remove a response from the in-memory store.
 */
export function removeResponse(responseId: string): void {
  responseStore.delete(responseId);
}
