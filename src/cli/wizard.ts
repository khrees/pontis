import {
  splash,
  section,
  badge,
  kv,
  error,
  select,
  t,
} from "./ui";
import { selectProviderInteractive, selectClientInteractive } from "./ui";
import { setupLocalInteractive, detectRunningLocalEngine } from "./provider-local";
import { setupOpenCodeInteractive, getOpenCodeApiKeyInteractive } from "./provider-opencode";
import { setupCloudflareInteractive, getCloudflareConfigInteractive } from "./provider-cloudflare";
import { startProxy, killActiveProxy } from "./proxy-manager";
import {
  launchClient,
  testConnectivity,
  ensureClientReady,
  setupPiProvider,
  cleanupPiProvider,
  setupOpenCodeProvider,
  cleanupOpenCodeProvider,
  setupCodexProvider,
  cleanupCodexProvider,
} from "./client-launcher";
import {
  getCloudflareConfigSaved,
  getLocalApiKey,
  getOpenCodeApiKey,
  FALLBACK_MODELS,
  CLOUDFLARE_FALLBACK_MODELS,
  type PontisEnv,
} from "./config";
import {
  checkAll,
  CLIENTS,
  type ClientName,
  cmdClientsInteractive,
} from "./install-engine";
import {
  getPreferences,
  savePreferences,
  updateLastUsed,
  getLastUsed,
  type ProviderType,
} from "./preferences";
import { cmdAuthInteractive } from "./auth";

/**
 * Interactive wizard entrypoint.
 * If user has saved credentials, presents a fast 1-click Quick Launch menu.
 * If first-time user, guides them through minimal onboarding steps.
 */
export async function runInteractiveWizard(env: PontisEnv) {
  splash();

  const prefs = getPreferences();
  const lastUsed = getLastUsed();
  const openCodeKey = getOpenCodeApiKey();
  const cfConfig = getCloudflareConfigSaved();
  const clientStatus = checkAll();

  const hasConfiguredCredentials = !!openCodeKey || !!(cfConfig.apiToken && cfConfig.accountId) || !!prefs.localEndpoint;

  // Returning user with credentials -> Quick Launch Fast Path
  if (hasConfiguredCredentials && !env.provider && !env.model && !env.clientCmd) {
    const activeProvider: ProviderType = prefs.defaultProvider || lastUsed?.provider || (openCodeKey ? "opencode" : "local");
    const activeModel = prefs.defaultModel || lastUsed?.model || (activeProvider === "cloudflare" ? CLOUDFLARE_FALLBACK_MODELS[0] : FALLBACK_MODELS[0]);
    const defaultClient = (prefs.defaultClient || lastUsed?.client || "claude") as ClientName | "server";

    const defaultClientLabel = defaultClient === "server" ? "Server Mode" : CLIENTS[defaultClient]?.name || "Claude Code";
    const providerLabel = activeProvider === "opencode" ? "OpenCode" : activeProvider === "cloudflare" ? "Cloudflare" : "Local";

    const quickChoices = [
      `${t.primary(`▶ Launch ${defaultClientLabel}`)}  ${t.muted(`(${activeModel} · ${providerLabel})`)}`,
      `${t.primary("Launch Codex CLI")}`,
      `${t.primary("Launch OpenCode")}`,
      `${t.primary("Launch Pi")}`,
      `${t.primary("Run Proxy Server Only")}`,
      `${t.muted("⚙ Switch Provider or Model")}`,
      `${t.muted("🔑 Manage Authentication & Keys")}`,
      `${t.muted("💻 Manage Coding Agent CLIs")}`,
    ];

    const quickRes = await select("Quick Launch", quickChoices, {
      allowCustom: false,
      defaultIndex: 0,
    });

    if (quickRes.index === 0) {
      return runWithConfig(defaultClient, { model: activeModel, provider: activeProvider }, []);
    } else if (quickRes.index === 1) {
      return runWithConfig("codex", { model: activeModel, provider: activeProvider }, []);
    } else if (quickRes.index === 2) {
      return runWithConfig("opencode", { model: activeModel, provider: activeProvider }, []);
    } else if (quickRes.index === 3) {
      return runWithConfig("pi", { model: activeModel, provider: activeProvider }, []);
    } else if (quickRes.index === 4) {
      return runWithConfig("server", { model: activeModel, provider: activeProvider }, []);
    } else if (quickRes.index === 6) {
      await cmdAuthInteractive();
      return;
    } else if (quickRes.index === 7) {
      await cmdClientsInteractive();
      return;
    }
    // Index 5 continues to provider selection below
  }

  // Step 1: Provider selection
  const detectedLocal = await detectRunningLocalEngine();
  const provider = env.provider || (await selectProviderInteractive(detectedLocal ? `${detectedLocal.name}` : null));

  // Step 2: API key + Model setup
  let model: string;
  let apiKey: string;
  let upstreamUrl: string | undefined;

  if (provider === "local") {
    section("Local AI Setup");
    const local = await setupLocalInteractive();
    model = env.model || local.model;
    apiKey = env.apiKey || local.apiKey;
    upstreamUrl = local.upstreamUrl;
  } else if (provider === "cloudflare") {
    section("Cloudflare AI Gateway Setup");
    const cf = await setupCloudflareInteractive();
    model = env.model || cf.model;
    apiKey = env.apiKey || cf.apiKey;
    upstreamUrl = cf.upstreamUrl;
  } else {
    section("OpenCode Setup");
    const oc = await setupOpenCodeInteractive();
    model = env.model || oc.model;
    apiKey = env.apiKey || oc.apiKey;
  }

  // Step 3: Pick client
  const defaultClientChoice = prefs.defaultClient || "claude";
  const clientCmd = (env.clientCmd || (await selectClientInteractive(clientStatus, defaultClientChoice))) as ClientName | "server";

  // Step 4: Ensure client is ready / installed
  if (clientCmd !== "server") {
    const ready = await ensureClientReady(clientCmd, true);
    if (!ready) {
      const name = CLIENTS[clientCmd]?.name || clientCmd;
      error(`${name} is required to continue.`);
    }
  }

  // Save choices to preferences
  savePreferences({
    defaultProvider: provider,
    defaultModel: model,
    defaultClient: clientCmd,
    ...(upstreamUrl ? { localEndpoint: upstreamUrl } : {}),
  });
  updateLastUsed(clientCmd, provider, model);

  // Step 5: Start proxy & launch
  await launchProxyAndClient(clientCmd, model, apiKey, provider, upstreamUrl, []);
}

/**
 * Direct launch with explicit config or environment defaults.
 */
export async function runWithConfig(
  clientCmd: string,
  opts: Record<string, any>,
  extraArgs: string[],
) {
  splash();

  const prefs = getPreferences();
  const lastUsed = getLastUsed();

  // Resolve provider
  const provider: ProviderType =
    opts.provider ||
    (process.env.PONTIS_PROVIDER as ProviderType) ||
    prefs.defaultProvider ||
    (process.env.PONTIS_UPSTREAM_URL ? "local" : "opencode");

  const savedCf = getCloudflareConfigSaved();
  let upstreamUrl = opts.upstream || process.env.PONTIS_UPSTREAM_URL || (provider === "local" ? prefs.localEndpoint : undefined);

  if (!upstreamUrl && provider === "cloudflare") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || savedCf.accountId;
    const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID || savedCf.gatewayId || "default";
    if (accountId) {
      upstreamUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/v1`;
    }
  }

  const upstreamFormat = opts.format || process.env.PONTIS_UPSTREAM_FORMAT || "openai";
  const modelFromOptsEnv = opts.model || process.env.PONTIS_MODEL;

  // Resolve model
  let model =
    modelFromOptsEnv ||
    prefs.defaultModel ||
    (lastUsed?.provider === provider ? lastUsed.model : undefined) ||
    (provider === "cloudflare" ? CLOUDFLARE_FALLBACK_MODELS[0] : FALLBACK_MODELS[0]);

  // Resolve API key
  let apiKey =
    opts.apiKey ||
    (provider === "local"
      ? getLocalApiKey()
      : provider === "cloudflare"
        ? (process.env.CLOUDFLARE_API_TOKEN || savedCf.apiToken)
        : (process.env.OPENCODE_API_KEY || getOpenCodeApiKey()));

  // Prompt for missing credentials seamlessly if needed
  if (!apiKey) {
    if (provider === "opencode") {
      apiKey = await getOpenCodeApiKeyInteractive();
    } else if (provider === "cloudflare") {
      const cf = await getCloudflareConfigInteractive();
      apiKey = cf.apiToken;
      upstreamUrl = `https://gateway.ai.cloudflare.com/v1/${cf.accountId}/${cf.gatewayId}/workers-ai/v1`;
    } else {
      apiKey = getLocalApiKey();
    }
  }

  if (upstreamUrl) process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  if (upstreamFormat) process.env.PONTIS_UPSTREAM_FORMAT = upstreamFormat;
  process.env.PONTIS_PROVIDER = provider;

  if (!apiKey) error("API key required.");
  if (!model) error("Model required.");

  // Save session to lastUsed
  updateLastUsed(clientCmd as ClientName | "server", provider, model);

  // Ensure client is installed before launching
  if (clientCmd !== "server") {
    const autoInstall = opts.install !== false && process.env.PONTIS_AUTO_INSTALL !== "false";
    const ready = await ensureClientReady(clientCmd as ClientName, autoInstall);
    if (!ready) {
      const modeLabel = clientCmd === "codex" ? "Codex" : clientCmd === "pi" ? "Pi" : clientCmd === "opencode" ? "OpenCode" : "Claude Code";
      error(`${modeLabel} is required to continue. Install it or pass --no-install to skip this check.`);
    }
  }

  await launchProxyAndClient(clientCmd, model, apiKey, provider, upstreamUrl, extraArgs);
}

/**
 * Internal helper to configure proxy, environment, and launch client.
 */
async function launchProxyAndClient(
  clientCmd: string,
  model: string,
  apiKey: string,
  provider: ProviderType,
  upstreamUrl: string | undefined,
  extraArgs: string[],
) {
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

  kv("Mode", t.bold(modeLabel));
  kv(
    "Provider",
    provider === "local"
      ? "Local"
      : provider === "cloudflare"
        ? "Cloudflare AI Gateway"
        : "OpenCode",
  );
  kv("Model", t.primary(model));
  if (upstreamUrl) kv("Upstream", t.muted(upstreamUrl));
  console.log();

  try {
    await startProxy(model, false);

    // Client-specific provider wiring
    if (clientCmd === "pi") {
      setupPiProvider(apiKey, model);
      badge("muted", "Configured Pi provider in ~/.pi/agent/models.json");
    } else if (clientCmd === "opencode") {
      setupOpenCodeProvider(apiKey);
      badge("muted", "Configured OpenCode proxy auth in ~/.local/share/opencode/auth.json");
    } else if (clientCmd === "codex") {
      setupCodexProvider();
      badge("muted", "Configured Codex profile in ~/.codex/pontis.config.toml");
    }

    // Fast connectivity verification
    const ok = await testConnectivity(apiKey, model);
    if (!ok) {
      process.exit(1);
    }

    // Launch client process
    await launchClient(clientCmd, model, apiKey, extraArgs);
  } finally {
    if (clientCmd === "pi") cleanupPiProvider();
    if (clientCmd === "opencode") cleanupOpenCodeProvider();
    if (clientCmd === "codex") cleanupCodexProvider();
    killActiveProxy();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
}
