import { serve } from '@hono/node-server';
import app from './index';

const port = 8787;
console.log(`Starting OpenCode Cowork Proxy on port ${port}...`);

serve({
  fetch: app.fetch,
  port
}, (info) => {
  console.log(`OpenCode Cowork Proxy listening on http://localhost:${info.port}`);
});

