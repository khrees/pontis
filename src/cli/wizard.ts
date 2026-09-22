import {
  section,
  badge,
  kv,
  error,
  select,
  input,
  createSpinner,
  t,
} from "./ui";
import { storeGoogleApiKey, storeOpenCodeApiKey, storeCloudflareApiToken } from "../secure-storage";
import { selectProviderInteractive } from "./ui";
import { setupLocalInteractive, detectRunningLocalEngine, fetchLocalModels } from "./provider-local";
import { setupOpenCodeInteractive, getOpenCodeApiKeyInteractive, fetchOpenCodeModelsGrouped } from "./provider-opencode";

import {
  setupCloudflareInteractive,
  getCloudflareConfigInteractive,
  fetchCloudflareModels,
  sortCloudflareModels,
  KNOWN_CLOUDFLARE_MODELS,
  DEFAULT_CLOUDFLARE_MODEL,
} from "./provider-cloudflare";
import { setupGoogleInteractive, getGoogleApiKeyInteractive, fetchGoogleModels } from "./provider-google";
import { WizardStateMachine, type WizardContext } from "./wizard-machine";
import { createWizardSteps } from "./wizard-steps";
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
  getCloudflareUpstreamUrl,
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
  type ClientName,
} from "./install-engine";
import {
  getPreferences,
  savePreferences,
  updateLastUsed,
  getLastUsed,
  type ProviderType,
} from "./preferences";

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
  return bestDist <= 2 || (best !== null && best.startsWith(lower.slice(0, 3))) ? best : null;
}

export async function runInteractiveWizard(env: PontisEnv) {
  const lastUsed = getLastUsed();
  let initialProvider: ProviderType | undefined;
  if (env.provider) {
    const normalized = normalizeProvider(env.provider);
    if (!normalized) {
      const suggestion = closestProvider(env.provider);
      error(
        `Unknown provider "${env.provider}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} Valid providers: google, opencode, local, cloudflare.`,
      );
    }
    initialProvider = normalized;
  }

  const initialContext: WizardContext = {
    env,
    lastUsed:
      lastUsed?.client && lastUsed?.provider && lastUsed?.model
        ? { client: lastUsed.client, provider: lastUsed.provider, model: lastUsed.model }
        : undefined,
    provider: initialProvider,
    model: env.model,
    client: env.clientCmd as ClientName | "server" | undefined,
    apiKey: env.apiKey,
  };

  const steps = createWizardSteps();
  const machine = new WizardStateMachine(initialContext, steps);
  const result = await machine.run();

  if (!result) {
    console.log(`\n  ${t.muted("Wizard cancelled.")}\n`);
    return;
  }

  if (result.launchDirectly && result.client && result.provider && result.model) {
    await runWithConfig(
      result.client,
      { provider: result.provider, model: result.model },
      [],
      true,
    );
    return;
  }

  const clientCmd = (result.client || "claude") as ClientName | "server";
  const provider = result.provider || "opencode";
  const model =
    result.model ||
    (provider === "cloudflare" ? DEFAULT_CLOUDFLARE_MODEL : "mimo-v2.5-free");
  const apiKey = result.apiKey || (provider === "local" ? getLocalApiKey() : "");
  const upstreamUrl = result.upstreamUrl;

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

  await launchProxyAndClient(clientCmd, model, apiKey, provider, upstreamUrl, []);
}

export async function runWithConfig(
  clientCmd: string,
  opts: Record<string, any>,
  extraArgs: string[],
  _skipSplash = false,
) {
  const prefs = getPreferences();
  const openCodeKey = getOpenCodeApiKey();
  const savedCf = getCloudflareConfigSaved();

  const { provider, model } = resolveActiveProviderAndModel({
    provider: opts.provider,
    model: opts.model,
    upstream: opts.upstream,
  });

  let upstreamUrl =
    opts.upstream ||
    process.env.PONTIS_UPSTREAM_URL ||
    (provider === "google" ? GOOGLE_DEFAULT_UPSTREAM : (provider === "local" ? (prefs.localEndpoint || "http://localhost:11434/v1") : undefined));

  if (!upstreamUrl && provider === "cloudflare") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || savedCf.accountId;
    const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID || savedCf.gatewayId;
    if (accountId) {
      upstreamUrl = getCloudflareUpstreamUrl(accountId, gatewayId);
    }
  }

  const upstreamFormat = opts.format || process.env.PONTIS_UPSTREAM_FORMAT || "openai";

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
          upstreamUrl = getCloudflareUpstreamUrl(cf.accountId, cf.gatewayId);
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

  updateLastUsed(clientCmd as ClientName | "server", provider, model);

  const MODE_LABELS: Record<string, string> = {
    codex: "Codex",
    server: "Server",
    pi: "Pi",
    opencode: "OpenCode",
    claude: "Claude Code",
    hermes: "Hermes Agent",
  };

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

  process.env.PONTIS_PROVIDER = provider;
  process.env.PONTIS_MODEL = model;
  process.env.PONTIS_CLIENT = clientCmd;
  if (upstreamUrl) {
    process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  } else {
    delete process.env.PONTIS_UPSTREAM_URL;
  }

  try {
    process.env.PONTIS_API_KEY = apiKey;
    if (clientCmd === "codex" || clientCmd === "server") {
      process.env.OPENAI_API_KEY = apiKey;
    }
    const proxyInfo = await startProxy(model, false);
    let proxyUrl = proxyInfo.proxyUrl;

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

      process.env.PONTIS_PROVIDER = provider;
      process.env.PONTIS_MODEL = model;
      if (upstreamUrl) {
        process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
      } else {
        delete process.env.PONTIS_UPSTREAM_URL;
      }

      savePreferences({
        defaultProvider: provider,
        defaultModel: model,
        ...(upstreamUrl ? { localEndpoint: upstreamUrl } : {}),
      });
      updateLastUsed(clientCmd as ClientName | "server", provider, model);

      const updatedProxy = await startProxy(model, false);
      proxyUrl = updatedProxy.proxyUrl;

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

async function promptRecovery(
  provider: ProviderType,
  apiKey: string,
  failedModel: string,
  upstreamUrl?: string,
): Promise<RecoveryResult | null> {
  section("Auto-Recovery");
  console.log(`  ${t.muted("How would you like to resolve this connection issue?")}`);

  let availableModels: string[] = [];
  let opencodeRawMap = new Map<string, string>();
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
      const groups = await fetchOpenCodeModelsGrouped(apiKey, true);
      const total = groups.combined.length;
      opencodeRawMap = new Map([
        ...groups.free.map((m) => [`Free · ${m}`, m] as [string, string]),
        ...groups.frontier.map((m) => [`Frontier · ${m}`, m] as [string, string]),
        ...groups.chinese.map((m) => [`Chinese · ${m}`, m] as [string, string]),
        ...groups.others.map((m) => [`Others · ${m}`, m] as [string, string]),
      ]);
      availableModels = [...opencodeRawMap.keys()];
      spin.stop(
        availableModels.length > 0
          ? {
              type: "success",
              text: `${total} OpenCode models available (Inference API)`,
            }
          : { type: "warning", text: "No working models found from OpenCode API" },
      );
    } catch {
      spin.stop({ type: "warning", text: "No models returned from OpenCode API" });
    }

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
    availableModels = liveCf.length > 0 ? sortCloudflareModels(liveCf) : [...KNOWN_CLOUDFLARE_MODELS];
  } else {
    const prefs = getPreferences();
    const endpoint = upstreamUrl || prefs.localEndpoint || "http://localhost:11434/v1";
    const spin = createSpinner(`Fetching live models from local engine (${endpoint})...`);
    try {
      availableModels = await fetchLocalModels(endpoint, apiKey);
    } catch {}

    const cloudPullModels = availableModels.filter((m) => m.endsWith(":cloud") || m.includes(":cloud-"));
    const trueLocalModels = availableModels.filter((m) => !m.endsWith(":cloud") && !m.includes(":cloud-"));

    if (cloudPullModels.length > 0 && trueLocalModels.length < availableModels.length) {
      spin.stop({ type: "success", text: `${trueLocalModels.length} local models found (${cloudPullModels.length} cloud-pull models hidden — require internet)` });
    } else {
      spin.stop(
        availableModels.length > 0
          ? { type: "success", text: `${availableModels.length} local models found` }
          : { type: "warning", text: "No models returned from local engine" },
      );
    }

    availableModels = [...trueLocalModels, ...cloudPullModels];
  }

  if (opencodeRawMap.size > 0) {
    availableModels = availableModels.filter((label) => opencodeRawMap.get(label) !== failedModel);
  } else {
    availableModels = availableModels.filter((m) => m !== failedModel);
  }

  const ACTION_SWITCH = `🔄  Switch AI Provider (Google Gemini [100% Free], Local AI, Cloudflare)`;
  const ACTION_CONFIG = `🔑  Configure / Enter API Key for ${getProviderDisplayName(provider)}`;
  const ACTION_PROCEED = `▶   Proceed anyway with "${failedModel}" (skip verification)`;
  const ACTION_CANCEL = `${t.muted("Cancel / Exit")}`;

  const choices = [
    ACTION_SWITCH,
    ACTION_CONFIG,
    ACTION_PROCEED,
    ...availableModels,
    ACTION_CANCEL,
  ];

  const choice = await select("Choose how to resolve or pick a model", choices, {
    allowCustom: true,
    defaultIndex: 0,
  });

  if (choice.index === -1) {
    const customModel = choice.value.trim();
    if (!customModel) return null;
    return { provider, model: customModel, apiKey, upstreamUrl };
  }

  if (choice.value === ACTION_CANCEL) {
    return null;
  }

  if (choice.value === ACTION_SWITCH) {
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

  if (choice.value === ACTION_CONFIG) {
    if (provider === "opencode") {
      console.log(`\n  Enter your OpenCode API key from ${t.secondary("https://opencode.ai/console")}:`);
      const newKey = await input("OpenCode API Key", undefined, true);
      const clean = newKey.trim();
      if (clean) {
        storeOpenCodeApiKey(clean);
        badge("success", "OpenCode API key saved");
        return { provider, model: failedModel, apiKey: clean, upstreamUrl };
      }
    } else if (provider === "google") {
      const newKey = await input("Google AI Studio API Key", undefined, true);
      const clean = newKey.trim();
      if (clean) {
        storeGoogleApiKey(clean);
        badge("success", "Google API key saved");
        return { provider, model: failedModel, apiKey: clean, upstreamUrl };
      }
    } else if (provider === "cloudflare") {
      const newKey = await input("Cloudflare API Token", undefined, true);
      const clean = newKey.trim();
      if (clean) {
        storeCloudflareApiToken(clean);
        badge("success", "Cloudflare API token saved");
        return { provider, model: failedModel, apiKey: clean, upstreamUrl };
      }
    }
    return { provider, model: failedModel, apiKey, upstreamUrl };
  }

  if (choice.value === ACTION_PROCEED) {
    return {
      provider,
      model: failedModel,
      apiKey,
      upstreamUrl,
      proceedAnyway: true,
    };
  }

  const pickedRaw = opencodeRawMap.get(choice.value) ?? choice.value.replace(/^(Zen|Go) · /, "");
  return {
    provider,
    model: pickedRaw,
    apiKey,
    upstreamUrl,
  };
}
