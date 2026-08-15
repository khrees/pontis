import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { section, kv, badge, t, select, input, confirm, outputJson, splash } from "./ui";
import { redactKey } from "../redact";
import {
  CLOUDFLARE_CONFIG_FILE,
  LEGACY_KEY_FILE,
  getCloudflareConfigSaved,
  getOpenCodeApiKey,
  getLocalApiKey,
} from "./config";
import {
  storeOpenCodeApiKey,
  deleteOpenCodeApiKey,
  storeCloudflareApiToken,
  deleteCloudflareApiToken,
  storeLocalApiKey,
  deleteLocalApiKey,
  clearAllCredentials,
} from "../secure-storage";
import { getPreferences, savePreferences } from "./preferences";
import { detectRunningLocalEngine } from "./provider-local";

export interface AuthStatus {
  opencode: {
    configured: boolean;
    keyMasked: string | null;
  };
  cloudflare: {
    configured: boolean;
    accountId: string | null;
    gatewayId: string | null;
    tokenMasked: string | null;
  };
  local: {
    configured: boolean;
    endpoint: string;
    keyMasked: string | null;
  };
}

export function getAuthStatus(): AuthStatus {
  const openCodeKey = getOpenCodeApiKey();
  const cf = getCloudflareConfigSaved();
  const localKey = getLocalApiKey();
  const prefs = getPreferences();

  const isLocalCustomKey = localKey && localKey !== "local-model-dummy-api-key-value-32-chars-long";

  return {
    opencode: {
      configured: !!openCodeKey,
      keyMasked: openCodeKey ? redactKey(openCodeKey) : null,
    },
    cloudflare: {
      configured: !!(cf.apiToken && cf.accountId),
      accountId: cf.accountId ? `${cf.accountId.slice(0, 4)}...${cf.accountId.slice(-4)}` : null,
      gatewayId: cf.gatewayId || "default",
      tokenMasked: cf.apiToken ? redactKey(cf.apiToken) : null,
    },
    local: {
      configured: true,
      endpoint: prefs.localEndpoint || process.env.PONTIS_UPSTREAM_URL || "http://localhost:11434/v1",
      keyMasked: isLocalCustomKey ? redactKey(localKey) : null,
    },
  };
}

/**
 * List / display saved authentication details.
 */
export function cmdAuthStatus(opts?: { json?: boolean }): void {
  const status = getAuthStatus();

  if (opts?.json) {
    outputJson({ auth: status });
  }

  section("Saved Authentication & API Keys");

  // OpenCode
  if (status.opencode.configured) {
    kv("OpenCode", `${t.success("✓ Saved")}  ${t.muted(`(${status.opencode.keyMasked})`)}`);
  } else {
    kv("OpenCode", `${t.muted("○ Not configured")}  ${t.muted("(Run: pontis auth set opencode)")}`);
  }

  // Cloudflare
  if (status.cloudflare.configured) {
    const details = `Account: ${status.cloudflare.accountId} · Gateway: ${status.cloudflare.gatewayId} · Token: ${status.cloudflare.tokenMasked}`;
    kv("Cloudflare", `${t.success("✓ Saved")}  ${t.muted(`(${details})`)}`);
  } else {
    kv("Cloudflare", `${t.muted("○ Not configured")}  ${t.muted("(Run: pontis auth set cloudflare)")}`);
  }

  // Local
  kv("Local", `${t.success("✓ Ready")}  ${t.muted(`(${status.local.endpoint})`)}`);
  if (status.local.keyMasked) {
    kv("Local Key", t.muted(status.local.keyMasked));
  }

  console.log();
  badge("muted", "Add/update: pontis auth set <provider>");
  badge("muted", "Remove:     pontis auth remove <provider>");
  console.log();
}

/**
 * Add or update an API key for a provider.
 */
export async function cmdAuthSet(providerArg?: string, keyArg?: string): Promise<void> {
  let provider = providerArg?.toLowerCase().trim();

  if (!provider) {
    const res = await select("Which provider's credentials do you want to configure?", [
      `${t.primary("OpenCode")}     ${t.muted("Free cloud models (Zen/Go)")}`,
      `${t.primary("Cloudflare")}   ${t.muted("Workers AI via AI Gateway")}`,
      `${t.primary("Local")}        ${t.muted("Ollama, LM Studio, Llama.cpp…")}`,
    ], { allowCustom: false, defaultIndex: 0 });

    if (res.index === 0) provider = "opencode";
    else if (res.index === 1) provider = "cloudflare";
    else provider = "local";
  }

  if (provider === "opencode") {
    section("Configure OpenCode API Key");
    let key = keyArg;
    if (!key) {
      console.log(`  Get your key at ${t.secondary("https://opencode.ai/auth")} → Zen → API Keys\n`);
      key = await input("Paste your OpenCode API key", undefined, true);
    }
    if (!key) {
      badge("error", "API key cannot be empty.");
      process.exit(1);
    }

    storeOpenCodeApiKey(key.trim());
    if (existsSync(LEGACY_KEY_FILE)) {
      try { unlinkSync(LEGACY_KEY_FILE); } catch {}
    }

    badge("success", "OpenCode API key saved securely");
  } else if (provider === "cloudflare") {
    section("Configure Cloudflare AI Gateway");
    const saved = getCloudflareConfigSaved();

    const accountId = await input("Paste your Cloudflare Account ID", saved.accountId);
    if (!accountId) {
      badge("error", "Account ID is required.");
      process.exit(1);
    }

    const gatewayId = await input("Paste your Cloudflare AI Gateway ID", saved.gatewayId || "default");
    if (!gatewayId) {
      badge("error", "Gateway ID is required.");
      process.exit(1);
    }

    const apiToken = keyArg || (await input("Paste your Cloudflare API Token (API Key)", saved.apiToken, true));
    if (!apiToken) {
      badge("error", "API Token is required.");
      process.exit(1);
    }

    const config = { accountId: accountId.trim(), gatewayId: gatewayId.trim(), apiToken: apiToken.trim() };
    writeFileSync(CLOUDFLARE_CONFIG_FILE, JSON.stringify(config, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    storeCloudflareApiToken(config.apiToken);

    badge("success", "Cloudflare AI Gateway configuration saved securely");
  } else if (provider === "local") {
    section("Configure Local Provider");
    const prefs = getPreferences();
    const detected = await detectRunningLocalEngine();
    const defaultUrl = prefs.localEndpoint || detected?.url || "http://localhost:11434/v1";

    const endpoint = await input("Enter local endpoint URL", defaultUrl);
    savePreferences({ localEndpoint: endpoint.trim() });

    const key = keyArg !== undefined
      ? keyArg
      : await input("Enter local API key (optional, press Enter to skip)", undefined, true);

    if (key && key.trim()) {
      storeLocalApiKey(key.trim());
      badge("success", "Local endpoint and API key saved");
    } else {
      badge("success", "Local endpoint saved (no API key required)");
    }
  } else {
    badge("error", `Unknown provider "${provider}". Use: opencode | cloudflare | local`);
    process.exit(1);
  }
}

/**
 * Remove credentials for a provider.
 */
export async function cmdAuthRemove(providerArg?: string): Promise<void> {
  let provider = providerArg?.toLowerCase().trim();

  if (!provider) {
    const status = getAuthStatus();
    const choices = [
      `OpenCode ${status.opencode.configured ? t.success("✓ Configured") : t.muted("○ Empty")}`,
      `Cloudflare ${status.cloudflare.configured ? t.success("✓ Configured") : t.muted("○ Empty")}`,
      `Local Key ${status.local.keyMasked ? t.success("✓ Configured") : t.muted("○ Default")}`,
      `${t.error("Clear All Credentials")}`,
      `${t.muted("Cancel")}`,
    ];

    const res = await select("Which credentials do you want to remove?", choices, { allowCustom: false });
    if (res.index === 0) provider = "opencode";
    else if (res.index === 1) provider = "cloudflare";
    else if (res.index === 2) provider = "local";
    else if (res.index === 3) provider = "all";
    else return;
  }

  if (provider === "all") {
    await cmdAuthClear();
    return;
  }

  if (provider === "opencode") {
    deleteOpenCodeApiKey();
    if (existsSync(LEGACY_KEY_FILE)) {
      try { unlinkSync(LEGACY_KEY_FILE); } catch {}
    }
    badge("success", "OpenCode API key removed");
  } else if (provider === "cloudflare") {
    deleteCloudflareApiToken();
    if (existsSync(CLOUDFLARE_CONFIG_FILE)) {
      try { unlinkSync(CLOUDFLARE_CONFIG_FILE); } catch {}
    }
    badge("success", "Cloudflare configuration and token removed");
  } else if (provider === "local") {
    deleteLocalApiKey();
    const prefs = getPreferences();
    delete prefs.localEndpoint;
    savePreferences(prefs);
    badge("success", "Local custom key and endpoint configuration removed");
  } else {
    badge("error", `Unknown provider "${provider}". Use: opencode | cloudflare | local | all`);
    process.exit(1);
  }
}

/**
 * Clear all credentials and configurations.
 */
export async function cmdAuthClear(silent = false): Promise<void> {
  if (!silent) {
    const ok = await confirm("Are you sure you want to clear ALL saved API keys and credentials?", false);
    if (!ok) return;
  }

  clearAllCredentials();

  if (existsSync(LEGACY_KEY_FILE)) {
    try { unlinkSync(LEGACY_KEY_FILE); } catch {}
  }
  if (existsSync(CLOUDFLARE_CONFIG_FILE)) {
    try { unlinkSync(CLOUDFLARE_CONFIG_FILE); } catch {}
  }

  badge("success", "All authentication credentials cleared");
}

/**
 * Interactive auth manager dashboard.
 */
export async function cmdAuthInteractive(): Promise<void> {
  splash();
  cmdAuthStatus();

  const choices = [
    `${t.primary("Add or Update an API Key")}`,
    `${t.primary("Remove a Key / Log out")}`,
    `${t.error("Clear All Saved Credentials")}`,
    `${t.muted("Back")}`,
  ];

  const res = await select("Authentication Management", choices, { allowCustom: false, defaultIndex: 0 });

  if (res.index === 0) {
    await cmdAuthSet();
  } else if (res.index === 1) {
    await cmdAuthRemove();
  } else if (res.index === 2) {
    await cmdAuthClear();
  }
}
