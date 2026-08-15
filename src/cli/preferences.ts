import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientName } from "./install-engine";

export const PONTIS_DIR = join(homedir(), ".pontis");
export const PREFERENCES_FILE = join(PONTIS_DIR, "preferences.json");

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
  defaultClient?: ClientName | "server";
  localEndpoint?: string;
  autoInstall?: boolean;
  lastUsed?: LastUsedSession;
}

/** Ensure ~/.pontis exists with restricted permissions */
function ensurePontisDir(): void {
  if (!existsSync(PONTIS_DIR)) {
    mkdirSync(PONTIS_DIR, { recursive: true, mode: 0o700 });
  }
}

/** Read preferences from ~/.pontis/preferences.json */
export function getPreferences(): PontisPreferences {
  if (!existsSync(PREFERENCES_FILE)) {
    return {};
  }
  try {
    const raw = readFileSync(PREFERENCES_FILE, "utf-8");
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
  writeFileSync(PREFERENCES_FILE, JSON.stringify(updated, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return updated;
}

/** Reset all user preferences */
export function resetPreferences(): void {
  if (existsSync(PREFERENCES_FILE)) {
    try {
      unlinkSync(PREFERENCES_FILE);
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
  savePreferences({
    ...current,
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
