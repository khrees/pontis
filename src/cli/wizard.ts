import {
  splash,
  section,
  badge,
  kv,
  error,
  select,
  createSpinner,
  t,
} from "./ui";
import { selectProviderInteractive, selectClientInteractive } from "./ui";
import { setupLocalInteractive, detectRunningLocalEngine, fetchLocalModels } from "./provider-local";
import { setupOpenCodeInteractive, getOpenCodeApiKeyInteractive, fetchWorkingOpenCodeModels } from "./provider-opencode";
import { setupCloudflareInteractive, getCloudflareConfigInteractive, fetchCloudflareModels } from "./provider-cloudflare";
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
  getProviderDisplayName,
  resolveActiveProviderAndModel,
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
    const { provider: activeProvider, model: activeModel } = resolveActiveProviderAndModel();
    const defaultClient = (prefs.defaultClient || lastUsed?.client || "claude") as ClientName | "server";

    const defaultClientLabel = defaultClient === "server" ? "Server Mode" : CLIENTS[defaultClient]?.name || "Claude Code";
    const providerLabel = getProviderDisplayName(activeProvider);

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

    if (quickRes.index === 0) return runWithConfig(defaultClient, { model: activeModel, provider: activeProvider }, []);
    if (quickRes.index === 1) return runWithConfig("codex", { model: activeModel, provider: activeProvider }, []);
    if (quickRes.index === 2) return runWithConfig("opencode", { model: activeModel, provider: activeProvider }, []);
    if (quickRes.index === 3) return runWithConfig("pi", { model: activeModel, provider: activeProvider }, []);
    if (quickRes.index === 4) return runWithConfig("server", { model: activeModel, provider: activeProvider }, []);
    if (quickRes.index === 6) return cmdAuthInteractive();
    if (quickRes.index === 7) return cmdClientsInteractive();
    // Index 5: "Switch Provider or Model" continues to Step 1 below
  }

  // Step 1: Provider selection
  const detectedLocal = await detectRunningLocalEngine();
  const provider = env.provider || (await selectProviderInteractive(detectedLocal ? `${detectedLocal.name}` : null));

  // Step 2: API key + Model setup
  let model: string;
  let apiKey: string;
  let upstreamUrl: string | undefined;

  switch (provider) {
    case "local": {
      section("Local AI Setup");
      const local = await setupLocalInteractive();
      model = env.model || local.model;
      apiKey = env.apiKey || local.apiKey;
      upstreamUrl = local.upstreamUrl;
      break;
    }
    case "cloudflare": {
      section("Cloudflare AI Gateway Setup");
      const cf = await setupCloudflareInteractive();
      model = env.model || cf.model;
      apiKey = env.apiKey || cf.apiKey;
      upstreamUrl = cf.upstreamUrl;
      break;
    }
    default: {
      section("OpenCode Setup");
      const oc = await setupOpenCodeInteractive();
      model = env.model || oc.model;
      apiKey = env.apiKey || oc.apiKey;
      break;
    }
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
  const openCodeKey = getOpenCodeApiKey();
  const savedCf = getCloudflareConfigSaved();

  // 1 & 2. Resolve provider and model consistently
  const { provider, model } = resolveActiveProviderAndModel({
    provider: opts.provider,
    model: opts.model,
    upstream: opts.upstream,
  });

  // 3. Resolve upstream URL
  let upstreamUrl =
    opts.upstream ||
    process.env.PONTIS_UPSTREAM_URL ||
    (provider === "local" ? (prefs.localEndpoint || "http://localhost:11434/v1") : undefined);

  if (!upstreamUrl && provider === "cloudflare") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || savedCf.accountId;
    const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID || savedCf.gatewayId || "default";
    if (accountId) {
      upstreamUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/v1`;
    }
  }

  const upstreamFormat = opts.format || process.env.PONTIS_UPSTREAM_FORMAT || "openai";

  // 4. Resolve API key
  let apiKey = opts.apiKey;
  if (!apiKey) {
    switch (provider) {
      case "opencode": {
        apiKey = process.env.OPENCODE_API_KEY || openCodeKey || undefined;
        if (!apiKey) {
          apiKey = await getOpenCodeApiKeyInteractive();
        }
        break;
      }
      case "cloudflare": {
        apiKey = process.env.CLOUDFLARE_API_TOKEN || savedCf.apiToken;
        if (!apiKey || !savedCf.accountId) {
          const cf = await getCloudflareConfigInteractive();
          apiKey = cf.apiToken;
          upstreamUrl = `https://gateway.ai.cloudflare.com/v1/${cf.accountId}/${cf.gatewayId}/workers-ai/v1`;
        }
        break;
      }
      default: {
        apiKey = getLocalApiKey();
        break;
      }
    }
  }

  if (upstreamUrl) process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  if (upstreamFormat) process.env.PONTIS_UPSTREAM_FORMAT = upstreamFormat;
  process.env.PONTIS_PROVIDER = provider;

  if (!apiKey) error("API key required.");
  if (!model) error("Model required.");

  // Save session to lastUsed
  updateLastUsed(clientCmd as ClientName | "server", provider, model);

  const MODE_LABELS: Record<string, string> = {
    codex: "Codex",
    server: "Server",
    pi: "Pi",
    opencode: "OpenCode",
    claude: "Claude Code",
  };

  // Ensure client is installed before launching
  if (clientCmd !== "server") {
    const autoInstall = opts.install !== false && process.env.PONTIS_AUTO_INSTALL !== "false";
    const ready = await ensureClientReady(clientCmd as ClientName, autoInstall);
    if (!ready) {
      const modeLabel = MODE_LABELS[clientCmd] || "Claude Code";
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
  const MODE_LABELS: Record<string, string> = {
    codex: "Codex",
    server: "Server",
    pi: "Pi",
    opencode: "OpenCode",
    claude: "Claude Code",
  };
  const modeLabel = MODE_LABELS[clientCmd] || "Claude Code";

  kv("Mode", t.bold(modeLabel));
  kv("Provider", getProviderDisplayName(provider));
  kv("Model", t.primary(model));
  if (upstreamUrl) kv("Upstream", t.muted(upstreamUrl));
  console.log();

  try {
    await startProxy(model, false);

    // Client-specific provider wiring
    switch (clientCmd) {
      case "pi":
        setupPiProvider(apiKey, model);
        badge("muted", "Configured Pi provider in ~/.pi/agent/models.json");
        break;
      case "opencode":
        setupOpenCodeProvider(apiKey);
        badge("muted", "Configured OpenCode proxy auth in ~/.local/share/opencode/auth.json");
        break;
      case "codex":
        setupCodexProvider();
        badge("muted", "Configured Codex profile in ~/.codex/pontis.config.toml");
        break;
    }

    // Fast connectivity verification
    let ok = await testConnectivity(apiKey, model, provider);
    while (!ok && process.stdin.isTTY) {
      const recovered = await promptRecovery(provider, apiKey, model, upstreamUrl);
      if (!recovered) break;

      provider = recovered.provider;
      model = recovered.model;
      apiKey = recovered.apiKey;
      upstreamUrl = recovered.upstreamUrl;

      // Update runtime environment
      process.env.PONTIS_PROVIDER = provider;
      process.env.PONTIS_MODEL = model;
      if (upstreamUrl) {
        process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
      } else {
        delete process.env.PONTIS_UPSTREAM_URL;
      }

      // Persist preferences
      savePreferences({
        defaultProvider: provider,
        defaultModel: model,
        ...(upstreamUrl ? { localEndpoint: upstreamUrl } : {}),
      });
      updateLastUsed(clientCmd as ClientName | "server", provider, model);

      // Client-specific provider re-wiring
      switch (clientCmd) {
        case "pi":
          setupPiProvider(apiKey, model);
          badge("muted", "Updated Pi provider in ~/.pi/agent/models.json");
          break;
        case "opencode":
          setupOpenCodeProvider(apiKey);
          badge("muted", "Updated OpenCode proxy auth");
          break;
        case "codex":
          setupCodexProvider();
          break;
      }

      // Restart proxy with the new model & configuration
      await startProxy(model, false);
      ok = await testConnectivity(apiKey, model, provider);
    }

    if (!ok) {
      process.exit(1);
    }

    // Launch client process
    await launchClient(clientCmd, model, apiKey, extraArgs);
  } finally {
    switch (clientCmd) {
      case "pi":
        cleanupPiProvider();
        break;
      case "opencode":
        cleanupOpenCodeProvider();
        break;
      case "codex":
        cleanupCodexProvider();
        break;
    }
    killActiveProxy();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
}

export interface RecoveryResult {
  provider: ProviderType;
  model: string;
  apiKey: string;
  upstreamUrl?: string;
}

/**
 * Interactive connection recovery when a configured model or provider fails.
 * Allows picking working models or switching providers entirely.
 */
async function promptRecovery(
  provider: ProviderType,
  apiKey: string,
  failedModel: string,
  upstreamUrl?: string,
): Promise<RecoveryResult | null> {
  console.log(`\n  ${t.bold("Auto-Recovery")}`);
  console.log(`  ${t.muted("How would you like to resolve this connection issue?")}\n`);

  let availableModels: string[] = [];
  if (provider === "opencode") {
    const spin = createSpinner("Fetching live available models from OpenCode...");
    try {
      availableModels = await fetchWorkingOpenCodeModels(apiKey);
    } catch {}
    spin.stop(
      availableModels.length > 0
        ? { type: "success", text: `${availableModels.length} models available` }
        : { type: "warning", text: "No models returned from OpenCode API" },
    );
  } else if (provider === "cloudflare") {
    const savedCf = getCloudflareConfigSaved();
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || savedCf.accountId;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN || savedCf.apiToken;
    let liveCf: string[] = [];
    if (accountId && apiToken) {
      const spin = createSpinner("Fetching live Cloudflare models...");
      try {
        liveCf = await fetchCloudflareModels(accountId, apiToken);
      } catch {}
      spin.stop(
        liveCf.length > 0
          ? { type: "success", text: `${liveCf.length} Cloudflare models available` }
          : { type: "warning", text: "No models returned from Cloudflare" },
      );
    }
    availableModels = liveCf;
  } else {
    const prefs = getPreferences();
    const endpoint = upstreamUrl || prefs.localEndpoint || "http://localhost:11434/v1";
    const spin = createSpinner(`Fetching live models from local engine (${endpoint})...`);
    try {
      availableModels = await fetchLocalModels(endpoint, apiKey);
    } catch {}
    spin.stop(
      availableModels.length > 0
        ? { type: "success", text: `${availableModels.length} local models found` }
        : { type: "warning", text: "No models returned from local engine" },
    );
  }

  // Filter out the failed model from suggestions
  availableModels = availableModels.filter((m) => m !== failedModel);

  const choices = [
    ...availableModels,
    `${t.primary("⚙  Switch Provider (Cloudflare, OpenCode, Local)")}`,
    `${t.muted("Cancel / Exit")}`,
  ];

  const choice = await select("Choose a working model or switch provider", choices, {
    allowCustom: true,
    defaultIndex: 0,
  });

  // Custom manual model entry
  if (choice.index === -1) {
    const customModel = choice.value.trim();
    if (!customModel) return null;
    return { provider, model: customModel, apiKey };
  }

  // Cancel / Exit
  if (choice.index === choices.length - 1) {
    return null;
  }

  // Switch Provider option
  if (choice.index === choices.length - 2) {
    const detectedLocal = await detectRunningLocalEngine();
    const newProvider = await selectProviderInteractive(detectedLocal ? `${detectedLocal.name}` : null);

    let newModel: string;
    let newApiKey: string;
    let newUpstreamUrl: string | undefined;

    switch (newProvider) {
      case "local": {
        section("Local AI Setup");
        const local = await setupLocalInteractive();
        newModel = local.model;
        newApiKey = local.apiKey;
        newUpstreamUrl = local.upstreamUrl;
        break;
      }
      case "cloudflare": {
        section("Cloudflare AI Gateway Setup");
        const cf = await setupCloudflareInteractive();
        newModel = cf.model;
        newApiKey = cf.apiKey;
        newUpstreamUrl = cf.upstreamUrl;
        break;
      }
      default: {
        section("OpenCode Setup");
        const oc = await setupOpenCodeInteractive();
        newModel = oc.model;
        newApiKey = oc.apiKey;
        break;
      }
    }

    return {
      provider: newProvider,
      model: newModel,
      apiKey: newApiKey,
      upstreamUrl: newUpstreamUrl,
    };
  }

  // Selected a model from the list
  return {
    provider,
    model: choice.value,
    apiKey,
  };
}
