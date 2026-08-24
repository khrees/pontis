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
import { setupGoogleInteractive, getGoogleApiKeyInteractive, fetchGoogleModels } from "./provider-google";
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
  getGoogleAuthToken,
  getProviderDisplayName,
  normalizeProvider,
  resolveActiveProviderAndModel,
  GOOGLE_DEFAULT_UPSTREAM,
  type PontisEnv,
} from "./config";
import {
  checkAll,
  CLIENTS,
  type ClientName,
} from "./install-engine";
import {
  getPreferences,
  savePreferences,
  updateLastUsed,
  getLastUsed,
  type ProviderType,
} from "./preferences";

/** Levenshtein distance for "did you mean" suggestions. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

const VALID_PROVIDERS: ProviderType[] = ["google", "opencode", "local", "cloudflare"];

/** Suggest the closest valid provider for a mistyped value, or null. */
function closestProvider(value: string): ProviderType | null {
  const lower = value.toLowerCase().trim();
  let best: ProviderType | null = null;
  let bestDist = Infinity;
  for (const p of VALID_PROVIDERS) {
    const d = editDistance(lower, p);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  // Only suggest when it's plausibly a typo (within 2 edits or a prefix).
  return bestDist <= 2 || (best !== null && best.startsWith(lower.slice(0, 3))) ? best : null;
}

export async function runInteractiveWizard(env: PontisEnv) {
  splash();

  const prefs = getPreferences();
  const lastUsed = getLastUsed();

  // Quick launch: with a complete previous session and no explicit overrides,
  // offer a one-Enter relaunch (default). Anything else falls through to the
  // full wizard.
  if (
    !env.provider &&
    !env.model &&
    !env.clientCmd &&
    lastUsed?.client &&
    lastUsed?.provider &&
    lastUsed?.model
  ) {
    const clientName = CLIENTS[lastUsed.client as ClientName]?.name || lastUsed.client;
    const relaunch = await select(
      "Launch",
      [
        `Launch last session — ${clientName} · ${lastUsed.model} · ${getProviderDisplayName(lastUsed.provider)}`,
        `Set up / change provider, model, or client`,
      ],
      { allowCustom: false, defaultIndex: 0 },
    );
    if (relaunch.index === 0) {
      await runWithConfig(
        lastUsed.client as string,
        { provider: lastUsed.provider, model: lastUsed.model },
        [],
        true, // splash already shown above
      );
      return;
    }
  }

  const clientStatus = checkAll();
  const { provider: activeProvider } = resolveActiveProviderAndModel();

  const detectedLocal = await detectRunningLocalEngine();

  // Validate an explicitly-provided provider (--provider / PONTIS_PROVIDER): an
  // unknown value must not silently fall through to the OpenCode default and
  // overwrite the saved provider.
  let provider: ProviderType;
  if (env.provider) {
    const normalized = normalizeProvider(env.provider);
    if (!normalized) {
      const suggestion = closestProvider(env.provider);
      error(
        `Unknown provider "${env.provider}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} Valid providers: google, opencode, local, cloudflare.`,
      );
    }
    provider = normalized;
  } else {
    provider = await selectProviderInteractive(
      detectedLocal ? `${detectedLocal.name}` : null,
      activeProvider,
    );
  }

  // Step 2: API key + Model setup
  let model: string;
  let apiKey: string;
  let upstreamUrl: string | undefined;

  switch (provider) {
    case "google": {
      section("Google (Gemini) Setup");
      const g = await setupGoogleInteractive();
      model = env.model || g.model;
      apiKey = env.apiKey || g.apiKey;
      upstreamUrl = g.upstreamUrl;
      break;
    }
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
  const defaultClientChoice = prefs.defaultClient || lastUsed?.client || "claude";
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

  process.env.PONTIS_PROVIDER = provider;
  process.env.PONTIS_MODEL = model;
  if (upstreamUrl) {
    process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  } else {
    delete process.env.PONTIS_UPSTREAM_URL;
  }

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
  skipSplash = false,
) {
  if (!skipSplash) splash();

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
    (provider === "google" ? GOOGLE_DEFAULT_UPSTREAM : (provider === "local" ? (prefs.localEndpoint || "http://localhost:11434/v1") : undefined));

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
      case "google": {
        apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || getGoogleAuthToken() || undefined;
        if (!apiKey) {
          apiKey = await getGoogleApiKeyInteractive();
        }
        break;
      }
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
    hermes: "Hermes Agent",
  };

  // Ensure client is installed before launching
  if (clientCmd !== "server") {
    const autoInstall = opts.install !== false && process.env.PONTIS_AUTO_INSTALL !== "false";
    const ready = await ensureClientReady(clientCmd as ClientName, autoInstall);
    if (!ready) {
      const modeLabel = MODE_LABELS[clientCmd] || "Claude Code";
      if (autoInstall) {
        error(
          `${modeLabel} is required to continue, but automatic installation did not complete. Install it with: pontis install ${clientCmd}`,
        );
      } else {
        error(
          `${modeLabel} is not installed and --no-install was given. Install it with: pontis install ${clientCmd}`,
        );
      }
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
    hermes: "Hermes Agent",
  };
  const modeLabel = MODE_LABELS[clientCmd] || "Claude Code";

  kv("Mode", t.bold(modeLabel));
  kv("Provider", getProviderDisplayName(provider));
  kv("Model", t.primary(model));
  if (upstreamUrl) kv("Upstream", t.muted(upstreamUrl));

  // Set environment for proxy and client processes
  process.env.PONTIS_PROVIDER = provider;
  process.env.PONTIS_MODEL = model;
  if (upstreamUrl) {
    process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  } else {
    delete process.env.PONTIS_UPSTREAM_URL;
  }

  try {
    const proxyInfo = await startProxy(model, false);
    let proxyUrl = proxyInfo.proxyUrl;

    // Client-specific provider wiring
    switch (clientCmd) {
      case "pi":
        setupPiProvider(apiKey, model, proxyUrl);
        badge("muted", "Configured Pi provider in ~/.pi/agent/models.json");
        break;
      case "opencode":
        setupOpenCodeProvider(apiKey, proxyUrl);
        badge("muted", "Configured OpenCode proxy auth in ~/.local/share/opencode/auth.json");
        break;
      case "codex":
        setupCodexProvider(proxyUrl);
        badge("muted", "Configured Codex profile in ~/.codex/pontis.config.toml");
        break;
    }

    // Fast connectivity verification
    let ok = await testConnectivity(apiKey, model, provider, proxyUrl);
    while (!ok && process.stdin.isTTY) {
      const recovered = await promptRecovery(provider, apiKey, model, upstreamUrl);
      if (!recovered) break;
      if (recovered.proceedAnyway) {
        ok = true;
        break;
      }

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

      // Restart proxy with the new model & configuration
      const updatedProxy = await startProxy(model, false);
      proxyUrl = updatedProxy.proxyUrl;

      // Client-specific provider re-wiring
      switch (clientCmd) {
        case "pi":
          setupPiProvider(apiKey, model, proxyUrl);
          badge("muted", "Updated Pi provider in ~/.pi/agent/models.json");
          break;
        case "opencode":
          setupOpenCodeProvider(apiKey, proxyUrl);
          badge("muted", "Updated OpenCode proxy auth");
          break;
        case "codex":
          setupCodexProvider(proxyUrl);
          break;
      }

      ok = await testConnectivity(apiKey, model, provider, proxyUrl);
    }

    if (!ok) {
      process.exit(1);
    }

    // Launch client process
    await launchClient(clientCmd, model, apiKey, extraArgs, proxyUrl);
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
  proceedAnyway?: boolean;
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
  section("Auto-Recovery");
  console.log(`  ${t.muted("How would you like to resolve this connection issue?")}`);

  let availableModels: string[] = [];
  if (provider === "google") {
    const spin = createSpinner("Fetching live available models from Google AI...");
    try {
      availableModels = await fetchGoogleModels(apiKey);
    } catch {}
    spin.stop(
      availableModels.length > 0
        ? { type: "success", text: `${availableModels.length} Google models available` }
        : { type: "warning", text: "Using default Gemini model list" },
    );
  } else if (provider === "opencode") {
    const spin = createSpinner("Fetching live available models from OpenCode...");
    try {
      availableModels = await fetchWorkingOpenCodeModels(apiKey, true);
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
    `${t.accent(`▶  Proceed anyway with "${failedModel}" (skip verification)`)}`,
    `${t.primary("⚙  Switch Provider (Google, Cloudflare, OpenCode, Local)")}`,
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
    return { provider, model: customModel, apiKey, upstreamUrl };
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
      case "google": {
        section("Google (Gemini) Setup");
        const g = await setupGoogleInteractive();
        newModel = g.model;
        newApiKey = g.apiKey;
        newUpstreamUrl = g.upstreamUrl;
        break;
      }
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

  // Proceed anyway option
  if (choice.index === choices.length - 3) {
    return {
      provider,
      model: failedModel,
      apiKey,
      upstreamUrl,
      proceedAnyway: true,
    };
  }

  // Selected a model from the list
  return {
    provider,
    model: choice.value,
    apiKey,
    upstreamUrl,
  };
}
