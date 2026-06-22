import { serve } from "@hono/node-server";
import app from "./index";

const port = 8787;
console.log(`Starting Pontis on port ${port}...`);

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Pontis listening on http://localhost:${info.port}`);
  },
);
