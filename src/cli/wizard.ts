import {
  splash,
  section,
  badge,
  kv,
  error,
} from "./ui";
import { selectProviderInteractive, selectClientInteractive } from "./ui";
import { setupLocalInteractive, selectLocalEngineInteractive } from "./provider-local";
import { setupOpenCodeInteractive } from "./provider-opencode";
import { setupCloudflareInteractive } from "./provider-cloudflare";
import { startProxy, killActiveProxy } from "./proxy-manager";
import {
  launchClient,
  testConnectivity,
  ensureClientReady,
  setupPiProvider,
  cleanupPiProvider,
} from "./client-launcher";
import {
  getCloudflareConfigSaved,
  getLocalApiKey,
  FALLBACK_MODELS,
  CLOUDFLARE_FALLBACK_MODELS,
  type PontisEnv,
} from "./config";
import { type ClientName } from "./install-engine";

export async function runInteractiveWizard(env: PontisEnv) {
  splash();

  // Step 1: Provider
  const provider = env.provider || (await selectProviderInteractive());

  // Step 2: API key + Model
  let model: string;
  let apiKey: string;

  if (provider === "local") {
    section("Local Setup");
    const local = await setupLocalInteractive();
    model = env.model || local.model;
    apiKey = env.apiKey || local.apiKey;
  } else if (provider === "cloudflare") {
    section("Cloudflare Setup");
    const cf = await setupCloudflareInteractive();
    model = env.model || cf.model;
    apiKey = env.apiKey || cf.apiKey;
  } else {
    section("OpenCode Setup");
    const oc = await setupOpenCodeInteractive();
    model = env.model || oc.model;
    apiKey = env.apiKey || oc.apiKey;
  }

  // Step 3: Pick client
  const clientCmd = (env.clientCmd || (await selectClientInteractive())) as ClientName | "server";

  // Step 4: Ensure client is installed (generic — works for all clients)
  if (clientCmd !== "server") {
    const ready = await ensureClientReady(clientCmd, true);
    if (!ready) {
      error(`${clientCmd === "claude" ? "Claude Code" : clientCmd === "codex" ? "Codex" : clientCmd === "opencode" ? "OpenCode" : "Pi"} is required to continue.`);
    }
  }

  // Step 5: Start proxy
  section("Infrastructure");
  badge("muted", `Model: ${model}`);

  try {
    await startProxy(model, clientCmd === "codex");

    // Step 6: Pi provider config (must be done after proxy is up)
    if (clientCmd === "pi") {
      setupPiProvider(apiKey, model);
      badge("muted", `Pi config: ~/.pi/agent/models.json (pontis provider)`);
    }

    // Step 7: Connectivity
    const ok = await testConnectivity(apiKey, model);
    if (!ok) {
      process.exit(1);
    }

    // Step 8: Launch
    await launchClient(clientCmd, model, apiKey, []);
  } finally {
    if (clientCmd === "pi") cleanupPiProvider();
    killActiveProxy();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
}

export async function runWithConfig(
  clientCmd: string,
  opts: Record<string, any>,
  extraArgs: string[],
) {
  splash();

  const provider: "opencode" | "local" | "cloudflare" =
    opts.provider ||
    (process.env.PONTIS_PROVIDER as "opencode" | "local" | "cloudflare") ||
    (process.env.PONTIS_UPSTREAM_URL ? "local" : "opencode");
  const savedCf = getCloudflareConfigSaved();
  let upstreamUrl = opts.upstream || process.env.PONTIS_UPSTREAM_URL;
  if (!upstreamUrl && provider === "cloudflare") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || savedCf.accountId;
    const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID || savedCf.gatewayId || "default";
    if (accountId) {
      upstreamUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/v1`;
    }
  }
  const upstreamFormat = opts.format || process.env.PONTIS_UPSTREAM_FORMAT;
  const modelFromOptsEnv = opts.model || process.env.PONTIS_MODEL;
  let apiKey =
    opts.apiKey ||
    (provider === "local"
      ? getLocalApiKey()
      : provider === "cloudflare"
        ? (process.env.CLOUDFLARE_API_TOKEN || savedCf.apiToken)
        : process.env.OPENCODE_API_KEY);
  let model = modelFromOptsEnv || (provider === "cloudflare" ? CLOUDFLARE_FALLBACK_MODELS[0] : FALLBACK_MODELS[0]);

  if (upstreamUrl) process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  if (upstreamFormat) process.env.PONTIS_UPSTREAM_FORMAT = upstreamFormat;
  process.env.PONTIS_PROVIDER = provider;

  const hasModel = !!modelFromOptsEnv;
  const hasApiKey = !!opts.apiKey || (provider === "cloudflare" && !!apiKey) || (provider === "opencode" && !!apiKey) || (provider === "local" && !!apiKey);

  if (!hasApiKey || !hasModel) {
    if (provider === "local") {
      if (!upstreamUrl) {
        upstreamUrl = await selectLocalEngineInteractive();
        process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
      }
      if (opts.apiKey) process.env.LOCAL_API_KEY = opts.apiKey;
      apiKey = getLocalApiKey();
      const local = await setupLocalInteractive();
      model = hasModel ? model : local.model;
      apiKey = apiKey || local.apiKey;
    } else if (provider === "cloudflare") {
      if (opts.apiKey) process.env.CLOUDFLARE_API_TOKEN = opts.apiKey;
      const cf = await setupCloudflareInteractive();
      model = hasModel ? model : cf.model;
      apiKey = apiKey || cf.apiKey;
      upstreamUrl = upstreamUrl || cf.upstreamUrl;
    } else {
      if (opts.apiKey) process.env.OPENCODE_API_KEY = opts.apiKey;
      apiKey = apiKey || process.env.OPENCODE_API_KEY;
      const oc = await setupOpenCodeInteractive();
      model = hasModel ? model : oc.model;
      apiKey = apiKey || oc.apiKey;
    }
  } else if (provider === "local" && !upstreamUrl) {
    error("Upstream URL required. Use --upstream or PONTIS_UPSTREAM_URL.");
  } else if (provider === "cloudflare" && !upstreamUrl) {
    error("Cloudflare Setup incomplete. Account ID and Gateway ID are required.");
  }

  if (!apiKey) error("API key required.");
  if (!model) error("Model required.");

  section("Configuration");
  const modeLabel =
    clientCmd === "codex"
      ? "Codex"
      : clientCmd === "server"
        ? "Server"
        : clientCmd === "pi"
          ? "Pi"
          : clientCmd === "opencode"
            ? "OpenCode"
            : "Claude Code";
  kv("Mode", modeLabel);
  kv(
    "Provider",
    provider === "local"
      ? "Local"
      : provider === "cloudflare"
        ? "Cloudflare AI Gateway"
        : "OpenCode",
  );
  kv("Model", model);
  if (upstreamUrl) kv("Upstream", upstreamUrl);
  console.log();

  // Ensure client is installed before launching
  if (clientCmd !== "server") {
    const autoInstall = opts.install !== false && process.env.PONTIS_AUTO_INSTALL !== "false";
    const ready = await ensureClientReady(clientCmd as any, autoInstall);
    if (!ready) {
      error(`${modeLabel} is required to continue. Install it or pass --no-install to skip this check.`);
    }
  }

  try {
    await startProxy(model, clientCmd === "codex");

    if (clientCmd === "pi") {
      setupPiProvider(apiKey, model);
    }

    const ok = await testConnectivity(apiKey, model);
    if (!ok) process.exit(1);
    await launchClient(clientCmd, model, apiKey, extraArgs);
  } finally {
    if (clientCmd === "pi") cleanupPiProvider();
    killActiveProxy();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
}
