/**
 * Install Engine — install client coding agents on the fly
 * using their official install methods.
 *
 * Philosophy:
 *   - If the binary is already on PATH → use it (honor existing installs).
 *   - If missing → run the tool's official installer (curl | sh, npm, etc.).
 *   - Never install a duplicate copy if one already exists.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { badge, confirm, createSpinner, t } from "./ui";

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export type ClientName = "claude" | "codex" | "opencode" | "pi";

export interface ClientDef {
  /** Display name (e.g. "Claude Code") */
  name: string;
  /** Binary name on PATH (e.g. "claude") */
  binary: string;
  /** Official curl-pipe installer URL, or null for npm-only tools */
  installScript: string | null;
  /** npm package name (used when installScript is null) */
  npmPackage?: string;
  /** Minimum Node.js version required, or null if native binary */
  minNodeVersion: string | null;
  /** Human-friendly install hint for error messages */
  installHint: string;
  /** Package name shown in prompts */
  packageLabel: string;
  /** Env var the installer respects for custom install dir (if any) */
  installDirEnv?: string;
}

// ──────────────────────────────────────────────
//  Client registry
// ──────────────────────────────────────────────

export const CLIENTS: Record<ClientName, ClientDef> = {
  claude: {
    name: "Claude Code",
    binary: "claude",
    installScript: "https://claude.ai/install.sh",
    minNodeVersion: null, // ships native binary via the installer
    installHint: "curl -fsSL https://claude.ai/install.sh | bash",
    packageLabel: "@anthropic-ai/claude-code",
  },
  codex: {
    name: "Codex CLI",
    binary: "codex",
    installScript: "https://chatgpt.com/codex/install.sh",
    minNodeVersion: null,
    installHint: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    packageLabel: "@openai/codex",
  },
  opencode: {
    name: "OpenCode",
    binary: "opencode",
    installScript: "https://opencode.ai/install",
    minNodeVersion: null,
    installHint: "curl -fsSL https://opencode.ai/install | bash",
    packageLabel: "opencode-ai",
    installDirEnv: "OPENCODE_INSTALL_DIR",
  },
  pi: {
    name: "Pi",
    binary: "pi",
    installScript: null, // npm-only
    npmPackage: "@earendil-works/pi-coding-agent",
    minNodeVersion: "22.19",
    installHint: "npm install -g @earendil-works/pi-coding-agent",
    packageLabel: "@earendil-works/pi-coding-agent",
  },
};

/** All client names */
export const ALL_CLIENTS: ClientName[] = ["claude", "codex", "opencode", "pi"];

/** Names that have a bash install script (vs npm-only) */
export const CLIENTS_WITH_INSTALL_SCRIPT: ClientName[] = [
  "claude",
  "codex",
  "opencode",
];

// ──────────────────────────────────────────────
//  Detection
// ──────────────────────────────────────────────

/**
 * Check if a binary is available on PATH.
 * Uses `which` (Unix) or `where` (Windows).
 */
export function binaryOnPath(binary: string): boolean {
  try {
    execSync(`which "${binary}" 2>/dev/null || command -v "${binary}" 2>/dev/null`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a specific client is installed (binary on PATH).
 */
export function isInstalled(name: ClientName): boolean {
  const def = CLIENTS[name];
  // For Pi, also check Node version
  if (name === "pi" && def.minNodeVersion) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    const [reqMajor, reqMinor] = def.minNodeVersion.split(".").map(Number);
    if (major < reqMajor || (major === reqMajor && minor < reqMinor)) {
      return false;
    }
  }
  return binaryOnPath(def.binary);
}

/**
 * Get the installation status of all clients.
 */
export function checkAll(): Record<ClientName, boolean> {
  const result = {} as Record<ClientName, boolean>;
  for (const name of ALL_CLIENTS) {
    result[name] = isInstalled(name);
  }
  return result;
}

// ──────────────────────────────────────────────
//  Installation
// ──────────────────────────────────────────────

/** Error thrown when installation fails. */
export class InstallError extends Error {
  constructor(
    public client: ClientName,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "InstallError";
  }
}

/**
 * Check Node version compatibility for a client.
 * Returns null if OK, or an error message if not.
 */
export function checkNodeVersion(name: ClientName): string | null {
  const def = CLIENTS[name];
  if (!def.minNodeVersion) return null;
  const [major, minor] = process.versions.node.split(".").map(Number);
  const [reqMajor, reqMinor] = def.minNodeVersion.split(".").map(Number);
  if (major < reqMajor || (major === reqMajor && minor < reqMinor)) {
    return `${def.name} requires Node >= ${def.minNodeVersion} (current: ${process.versions.node})`;
  }
  return null;
}

/**
 * Install a single client using its official method.
 * Throws InstallError on failure.
 */
export async function installClient(
  name: ClientName,
  options?: { interactive?: boolean; spinner?: ReturnType<typeof createSpinner> },
): Promise<void> {
  const def = CLIENTS[name];

  // Already installed?
  if (isInstalled(name)) {
    return;
  }

  // Node version check
  const nodeIssue = checkNodeVersion(name);
  if (nodeIssue) {
    throw new InstallError(name, nodeIssue);
  }

  // If interactive, prompt first
  if (options?.interactive !== false) {
    const ok = await confirm(
      `Install ${def.name}? (${def.installHint})`,
      true,
    );
    if (!ok) {
      throw new InstallError(
        name,
        `${def.name} installation cancelled`,
        `Install manually: ${def.installHint}`,
      );
    }
  }

  const spin =
    options?.spinner ??
    createSpinner(`Installing ${def.name}...`);

  try {
    if (def.installScript) {
      // Bash installer — pipe from URL to sh
      execSync(`curl -fsSL "${def.installScript}" | sh`, {
        stdio: "pipe",
        timeout: 120_000,
        env: {
          ...process.env,
          ...(def.installDirEnv ? { [def.installDirEnv]: join(homedir(), ".pontis", "clients", name) } : {}),
        },
      });
    } else if (def.npmPackage) {
      // npm install with --prefix to keep it isolated under ~/.pontis/clients/<name>
      const dest = join(homedir(), ".pontis", "clients", name);
      mkdirSync(dest, { recursive: true, mode: 0o755 });
      execSync(`npm install --prefix "${dest}" --ignore-scripts "${def.npmPackage}"`, {
        stdio: "pipe",
        timeout: 120_000,
      });
    } else {
      throw new InstallError(name, `No install method defined for ${def.name}`);
    }

    // Verify installation
    if (!isInstalled(name)) {
      // For npm --prefix installs, the binary might not be on PATH yet.
      // That's fine — the Pontis launcher adds ~/.pontis/clients/*/bin to PATH.
      if (!def.installScript) {
        // npm --prefix install: check if binary exists at the expected location
        const binDir = join(homedir(), ".pontis", "clients", name, "bin");
        const binPath = join(binDir, def.binary);
        if (!existsSync(binPath)) {
          // Try without --ignore-scripts
          execSync(`npm install --prefix "${join(homedir(), ".pontis", "clients", name)}" "${def.npmPackage}"`, {
            stdio: "pipe",
            timeout: 120_000,
          });
        }
      }
    }

    spin.stop({ type: "success", text: `${def.name} installed` });
  } catch (e: any) {
    spin.stop({
      type: "error",
      text: `Failed to install ${def.name}`,
    });
    throw new InstallError(
      name,
      e.message || String(e),
      `Install manually: ${def.installHint}`,
    );
  }
}

/**
 * Install multiple clients. Continues on error.
 * Returns a map of successes and failures.
 */
export async function installMany(
  names: ClientName[],
): Promise<{ ok: ClientName[]; failed: InstallError[] }> {
  const ok: ClientName[] = [];
  const failed: InstallError[] = [];

  for (const name of names) {
    try {
      if (isInstalled(name)) {
        ok.push(name);
        continue;
      }
      await installClient(name);
      ok.push(name);
    } catch (e: any) {
      if (e instanceof InstallError) {
        failed.push(e);
      } else {
        failed.push(new InstallError(name, e.message || String(e)));
      }
    }
  }

  return { ok, failed };
}

/**
 * Ensure a specific client is installed.
 * Returns true if available (was already installed or was just installed).
 * If `autoInstall` is false, just checks without prompting.
 */
export async function ensureClientInstalled(
  name: ClientName,
  options?: { autoInstall?: boolean; interactive?: boolean },
): Promise<boolean> {
  if (isInstalled(name)) return true;

  const def = CLIENTS[name];

  // Node version check
  const nodeIssue = checkNodeVersion(name);
  if (nodeIssue) {
    badge("warning", nodeIssue);
    return false;
  }

  if (options?.autoInstall === false) {
    badge("warning", `${def.name} is not installed`);
    return false;
  }

  try {
    await installClient(name, { interactive: options?.interactive });
    return isInstalled(name);
  } catch (e: any) {
    if (e instanceof InstallError && e.hint) {
      badge("muted", e.hint);
    }
    return false;
  }
}
