import { getRequestListener } from "@hono/node-server";
import { createServer } from "http";
import { createServer as createHttpsServer, request as httpsRequest } from "https";
import { WebSocketServer, type WebSocket } from "ws";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { resolve4 } from "node:dns/promises";
import app from "./index";
import { handleWebSocketConnection } from "./handlers/responses-ws";
import { getPort } from "./env";

const port = getPort(8787);

// ── Real IP of api.openai.com (for forwarding unrecognised requests) ──
// Resolved before any redirect is in place so we bypass /etc/hosts.
const REAL_OPENAI_IPS: Promise<string[]> = resolve4("api.openai.com").catch(
  () => ["172.66.0.243", "162.159.140.245"], // well-known fallback
);

// ── Certificate generation for TLS (Codex redirect) ──

const PONTIS_DIR = join(homedir(), ".pontis");
const TLS_CERT = join(PONTIS_DIR, "codex-cert.pem");
const TLS_KEY = join(PONTIS_DIR, "codex-key.pem");

function ensureSelfSignedCert(): { cert: string; key: string } {
  if (existsSync(TLS_CERT) && existsSync(TLS_KEY)) {
    return {
      cert: readFileSync(TLS_CERT, "utf-8"),
      key: readFileSync(TLS_KEY, "utf-8"),
    };
  }

  mkdirSync(PONTIS_DIR, { recursive: true, mode: 0o700 });

  // Generate a self-signed cert with CN=api.openai.com for Codex redirect
  const subj = "/CN=api.openai.com";
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${TLS_KEY}" -out "${TLS_CERT}" -days 365 -nodes -subj "${subj}" 2>/dev/null`,
      { stdio: "ignore" },
    );
  } catch {
    console.warn("  ⚠  Could not generate TLS cert (openssl not found)");
    return { cert: "", key: "" };
  }

  return {
    cert: readFileSync(TLS_CERT, "utf-8"),
    key: readFileSync(TLS_KEY, "utf-8"),
  };
}

// ── Proxy forwarder for unrecognised api.openai.com requests ──
// When Codex traffic is redirected (pf/hosts), requests like login/auth
// hit the TLS server. If Pontis doesn't handle them, we forward them to
// the real OpenAI API using the pre-resolved IP (bypassing /etc/hosts).

/**
 * Forward an HTTPS request to the real api.openai.com, using the pre-resolved
 * real IP (to bypass the /etc/hosts redirect) but setting the proper SNI
 * servername so the TLS certificate validates correctly.
 *
 * Uses Node's `https.request` directly because `fetch()` doesn't support
 * custom SNI / servername when connecting to an IP address.
 */
async function proxyToRealOpenAI(request: Request): Promise<Response> {
  const realIps = await REAL_OPENAI_IPS;
  if (realIps.length === 0) {
    return new Response("No upstream available", { status: 502 });
  }

  // Pick one IP (round-robin-ish by hashing the URL)
  const idx =
    Math.abs(
      request.url.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0),
    ) % realIps.length;
  const realIp = realIps[idx];

  const origUrl = new URL(request.url);

  // Collect request body
  let bodyBuffer: Buffer | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      const ab = await request.arrayBuffer();
      bodyBuffer = Buffer.from(ab);
    } catch {
      bodyBuffer = null;
    }
  }

  // Build headers (preserve original, override Host)
  const forwardHeaders: Record<string, string> = {
    Host: "api.openai.com",
  };
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower !== "host" && lower !== "connection" && lower !== "transfer-encoding") {
      forwardHeaders[key] = value;
    }
  });

  return new Promise<Response>((resolvePromise) => {
    const options = {
      hostname: realIp,
      port: 443,
      path: origUrl.pathname + origUrl.search,
      method: request.method,
      headers: forwardHeaders,
      servername: "api.openai.com", // SNI: validate cert against api.openai.com
      rejectUnauthorized: true,
    };

    const proxyReq = httpsRequest(options, (proxyRes) => {
      // Collect response body
      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on("end", () => {
        const responseBody = Buffer.concat(chunks);

        // Build response headers preserving passthrough headers
        const responseHeaders = new Headers();
        const rawHeaders = proxyRes.headers;
        for (const [key, value] of Object.entries(rawHeaders)) {
          if (value === undefined) continue;
          const lower = key.toLowerCase();
          if (["transfer-encoding", "connection", "keep-alive"].includes(lower)) continue;
          if (Array.isArray(value)) {
            for (const v of value) responseHeaders.append(key, v);
          } else {
            responseHeaders.set(key, value as string);
          }
        }

        resolvePromise(
          new Response(responseBody, {
            status: proxyRes.statusCode || 502,
            statusText: proxyRes.statusMessage,
            headers: responseHeaders,
          }),
        );
      });
    });

    proxyReq.on("error", (err) => {
      console.warn(`[proxy] Failed to forward to real OpenAI: ${err.message}`);
      resolvePromise(
        new Response(
          JSON.stringify({ error: { type: "proxy_error", message: err.message } }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
      );
    });

    // Set timeout
    proxyReq.setTimeout(30000, () => {
      proxyReq.destroy(new Error("proxy timeout"));
    });

    if (bodyBuffer) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  });
}

// ── Server setup ──

console.log(`Starting Pontis on port ${port}...`);

// ── Stale redirect check ──
// Warn if api.openai.com is still pinned to loopback from a crashed session.
try {
  const hostsContent = readFileSync("/etc/hosts", "utf-8");
  for (const line of hostsContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (
      parts.length >= 2 &&
      parts.slice(1).includes("api.openai.com") &&
      (parts[0] === "127.0.0.1" || parts[0] === "0.0.0.0")
    ) {
      console.warn(
        "  ⚠  Stale /etc/hosts entry for api.openai.com found!",
      );
      console.warn(
        "     Codex CLI will fail to connect until you remove it.",
      );
      console.warn(
        "     Fix: run →  pontis cleanup-redirect  (or manually remove the line)",
      );
      break;
    }
  }
} catch {
  // Can't read hosts file — skip warning
}

// Create the raw HTTP server so we can share it with WebSocket
const server = createServer(getRequestListener(app.fetch));

// WebSocket upgrade handler
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url || "", "http://localhost");
    if (url.pathname === "/v1/responses") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

wss.on("connection", (ws: WebSocket) => {
  handleWebSocketConnection(ws, app);
});

server.listen(port, () => {
  console.log(`Pontis listening on http://localhost:${port}`);
});

// ── Optional TLS server (for Codex wss:// redirect) ──
// This server handles traffic redirected from api.openai.com:443.
// Requests Pontis recognises go through the normal Hono app.
// Unrecognised requests (e.g. codex login/auth) are forwarded to the
// real OpenAI API using the pre-resolved IP.

const tlsPort = process.env.PONTIS_TLS_PORT
  ? parseInt(process.env.PONTIS_TLS_PORT, 10)
  : 0;

if (tlsPort) {
  const { cert, key } = ensureSelfSignedCert();
  if (cert && key) {
    // Wrap the Hono app fetch so we can intercept requests from the redirect
    const tlsFetchHandler = async (req: Request): Promise<Response> => {
      const host = req.headers.get("host") || "";
      // Detect requests that came via the pf/hosts redirect from api.openai.com
      const isRedirected = host.includes("api.openai.com");

      if (isRedirected) {
        const url = new URL(req.url);

        // Known Pontis API paths — let the Hono app handle them
        const knownPontisPaths = [
          "/v1/messages",
          "/v1/chat/completions",
          "/v1/completions",
          "/v1/responses",
          "/v1/models",
          "/",
          "/install",
        ];

        const isKnown = knownPontisPaths.some(
          (p) => url.pathname === p || url.pathname.startsWith(p + "/"),
        );

        if (!isKnown) {
          console.log(
            `[TLS] Forwarding ${req.method} ${url.pathname} to real OpenAI (not a Pontis path)`,
          );
          return proxyToRealOpenAI(req);
        }
      }

      // Let the Hono app handle it
      return app.fetch(req);
    };

    const tlsServer = createHttpsServer(
      { cert, key },
      getRequestListener(tlsFetchHandler),
    );

    // Also handle WS upgrade on TLS server
    const tlsWss = new WebSocketServer({ noServer: true });
    tlsServer.on("upgrade", (request, socket, head) => {
      try {
        const url = new URL(request.url || "", "https://localhost");
        if (url.pathname === "/v1/responses") {
          tlsWss.handleUpgrade(request, socket, head, (ws) => {
            tlsWss.emit("connection", ws, request);
          });
        } else {
          // Non-/v1/responses WebSocket connections are forwarded
          // via the proxy (they'll be regular HTTPS after TLS termination)
          socket.destroy();
        }
      } catch {
        socket.destroy();
      }
    });

    tlsWss.on("connection", (ws: WebSocket) => {
      handleWebSocketConnection(ws, app);
    });

    tlsServer.listen(tlsPort, () => {
      console.log(
        `  TLS server on https://localhost:${tlsPort} (for Codex wss:// redirect)`,
      );
      console.log(
        `  Cert: ${TLS_CERT} (add to system keychain if needed)`,
      );
      console.log(
        `  Unrecognised requests are forwarded to the real api.openai.com`,
      );
    });
  } else {
    console.warn(
      "  ⚠  TLS cert not available — Codex redirect will not work",
    );
  }
}
