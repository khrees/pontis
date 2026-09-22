import { getRequestListener } from "@hono/node-server";
import { createServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";
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

console.log(`Starting Pontis on port ${port}...`);

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
