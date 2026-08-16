import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientName } from "./install-engine";

export function getPontisDir(): string {
  return process.env.PONTIS_DIR || join(homedir(), ".pontis");
}

export function getPreferencesFile(): string {
  return join(getPontisDir(), "preferences.json");
}

export const PONTIS_DIR = getPontisDir();
export const PREFERENCES_FILE = getPreferencesFile();

export type ProviderType = "opencode" | "local" | "cloudflare";

export interface LastUsedSession {
  client?: ClientName | "server";
  provider?: ProviderType;
  model?: string;
  timestamp?: number;
}

export interface PontisPreferences {
  defaultProvider?: ProviderType;
  defaultModel?: string;
  providerModels?: Partial<Record<ProviderType, string>>;
  defaultClient?: ClientName | "server";
  localEndpoint?: string;
  autoInstall?: boolean;
  lastUsed?: LastUsedSession;
}

/** Ensure ~/.pontis exists with restricted permissions */
function ensurePontisDir(): void {
  const dir = getPontisDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Read preferences from ~/.pontis/preferences.json */
export function getPreferences(): PontisPreferences {
  const file = getPreferencesFile();
  if (!existsSync(file)) {
    return {};
  }
  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw) as PontisPreferences;
  } catch {
    return {};
  }
}

/** Save preferences to ~/.pontis/preferences.json */
export function savePreferences(prefs: Partial<PontisPreferences>): PontisPreferences {
  ensurePontisDir();
  const current = getPreferences();
  const updated: PontisPreferences = { ...current, ...prefs };
  writeFileSync(getPreferencesFile(), JSON.stringify(updated, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return updated;
}

/** Reset all user preferences */
export function resetPreferences(): void {
  const file = getPreferencesFile();
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {}
  }
}

/** Update the last-used session settings */
export function updateLastUsed(
  client: ClientName | "server",
  provider: ProviderType,
  model: string,
): void {
  const current = getPreferences();
  const providerModels = { ...(current.providerModels || {}), [provider]: model };
  savePreferences({
    ...current,
    defaultModel: model,
    providerModels,
    lastUsed: {
      client,
      provider,
      model,
      timestamp: Date.now(),
    },
  });
}

/** Get the last-used session if available */
export function getLastUsed(): LastUsedSession | null {
  const prefs = getPreferences();
  return prefs.lastUsed || null;
}
