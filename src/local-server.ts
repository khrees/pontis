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
import { getPort, getHost } from "./env";

const port = getPort(8787);
// Bind to loopback by default so the gateway is not reachable from the
// network. PONTIS_HOST can override (e.g. 0.0.0.0) for intentional LAN use.
const host = getHost("127.0.0.1");
const isLoopback =
  host === "127.0.0.1" || host === "localhost" || host === "::1";
// Display "localhost" for the friendly loopback case, the real host otherwise.
const displayHost = isLoopback ? "localhost" : host;

const REAL_OPENAI_IPS: Promise<string[]> = resolve4("api.openai.com").catch(
  () => ["172.66.0.243", "162.159.140.245"],
);

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

console.log(`Starting Pontis on port ${port}...`);

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
      console.warn("  ⚠  Stale /etc/hosts entry for api.openai.com found!");
      console.warn("     Codex CLI will fail to connect until you remove it.");
      console.warn("     Fix: run →  pontis cleanup-redirect  (or manually remove the line)");
      break;
    }
  }
} catch {}

const server = createServer(getRequestListener(app.fetch));
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

server.listen(port, host, () => {
  console.log(`Pontis listening on http://${displayHost}:${port}`);
  if (!isLoopback) {
    console.warn(
      `  ⚠  Bound to ${host} — the gateway (and your provider quota) is reachable from the network. Unset PONTIS_HOST to bind to localhost.`,
    );
  }
});

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

    tlsServer.listen(tlsPort, host, () => {
      console.log(
        `  TLS server on https://${displayHost}:${tlsPort} (for Codex wss:// redirect)`,
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
