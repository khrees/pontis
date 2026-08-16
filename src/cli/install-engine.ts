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
import { join } from "node:path";
import { homedir } from "node:os";
import { badge, confirm, createSpinner, section, kv, t, outputJson, select } from "./ui";
import { getPreferences, savePreferences } from "./preferences";

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export type ClientName = "claude" | "codex" | "opencode" | "pi";

export interface ClientDef {
  /** Display name (e.g. "Claude Code") */
  name: string;
  /** Short description */
  description: string;
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
    description: "Anthropic's official AI coding assistant",
    binary: "claude",
    installScript: "https://claude.ai/install.sh",
    minNodeVersion: null, // ships native binary via the installer
    installHint: "curl -fsSL https://claude.ai/install.sh | bash",
    packageLabel: "@anthropic-ai/claude-code",
  },
  codex: {
    name: "Codex CLI",
    description: "OpenAI's terminal coding agent",
    binary: "codex",
    installScript: "https://chatgpt.com/codex/install.sh",
    minNodeVersion: null,
    installHint: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    packageLabel: "@openai/codex",
  },
  opencode: {
    name: "OpenCode",
    description: "Open-source terminal AI coding assistant (opencode.ai)",
    binary: "opencode",
    installScript: "https://opencode.ai/install",
    minNodeVersion: null,
    installHint: "curl -fsSL https://opencode.ai/install | bash",
    packageLabel: "opencode-ai",
    installDirEnv: "OPENCODE_INSTALL_DIR",
  },
  pi: {
    name: "Pi",
    description: "The Pi coding agent (pi.dev)",
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
//  Detection & Resolution
// ──────────────────────────────────────────────

/**
 * Resolve a client binary path. Checks PATH first, then
 * falls back to ~/.pontis/clients/<name>/bin/<binary> for
 * Pontis-managed installations.
 */
export function resolveClientBinary(name: ClientName): string {
  try {
    const resolved = execSync(`which "${name}" 2>/dev/null || command -v "${name}" 2>/dev/null`, {
      encoding: "utf-8",
    }).trim();
    if (resolved) return resolved;
  } catch {
    // not found on PATH
  }
  // Fallback: Pontis-managed install under ~/.pontis/clients
  const local = join(homedir(), ".pontis", "clients", name, "bin", name);
  if (existsSync(local)) return local;
  // npm --prefix layout: node_modules/.bin/
  const npmBin = join(homedir(), ".pontis", "clients", name, "node_modules", ".bin", name);
  if (existsSync(npmBin)) return npmBin;
  // Last resort: trust the shell to find it
  return name;
}

/**
 * Get the full filesystem path for a client binary if installed.
 */
export function getClientPath(name: ClientName): string | null {
  if (!isInstalled(name)) return null;
  try {
    const binary = resolveClientBinary(name);
    if (existsSync(binary)) return binary;
    const resolved = execSync(`which "${binary}" 2>/dev/null || command -v "${binary}" 2>/dev/null`, {
      encoding: "utf-8",
    }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/**
 * Attempt to detect the installed version of a client.
 */
export function getClientVersion(name: ClientName): string | null {
  if (!isInstalled(name)) return null;
  const binary = resolveClientBinary(name);
  try {
    const output = execSync(`"${binary}" --version 2>&1`, {
      timeout: 1500,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) return null;
    const match = output.match(/(\d+\.\d+(\.\d+)?(-[a-zA-Z0-9.]+)?)/);
    return match ? `v${match[1]}` : output.split("\n")[0].slice(0, 20);
  } catch {
    return null;
  }
}

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
  return binaryOnPath(def.binary) || existsSync(join(homedir(), ".pontis", "clients", name, "bin", def.binary)) || existsSync(join(homedir(), ".pontis", "clients", name, "node_modules", ".bin", def.binary));
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

export interface ClientInfo {
  name: ClientName;
  displayName: string;
  description: string;
  binary: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  minNodeVersion: string | null;
  nodeIssue: string | null;
  installHint: string;
}

/**
 * Get comprehensive info for a client.
 */
export function getClientInfo(name: ClientName): ClientInfo {
  const def = CLIENTS[name];
  const installed = isInstalled(name);
  const nodeIssue = checkNodeVersion(name);
  const version = installed ? getClientVersion(name) : null;
  const path = installed ? getClientPath(name) : null;

  return {
    name,
    displayName: def.name,
    description: def.description,
    binary: def.binary,
    installed,
    version,
    path,
    minNodeVersion: def.minNodeVersion,
    nodeIssue,
    installHint: def.installHint,
  };
}

/**
 * Get comprehensive info for all supported clients.
 */
export function getAllClientsInfo(): ClientInfo[] {
  return ALL_CLIENTS.map((name) => getClientInfo(name));
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

/**
 * Display comprehensive list of all supported clients and their installation status.
 */
export function cmdClientsList(opts?: { json?: boolean }): void {
  const prefs = getPreferences();
  const defaultClient = prefs.defaultClient || "claude";
  const clients = getAllClientsInfo();

  if (opts?.json) {
    outputJson({
      defaultClient,
      clients: clients.map((c) => ({
        name: c.name,
        displayName: c.displayName,
        description: c.description,
        installed: c.installed,
        version: c.version,
        path: c.path,
        isDefault: c.name === defaultClient,
        nodeIssue: c.nodeIssue,
        installHint: c.installHint,
      })),
    });
  }

  section("Supported Coding Agent CLIs");

  for (const c of clients) {
    const isDef = c.name === defaultClient;
    const defBadge = isDef ? `  ${t.success("★ Default")}` : "";

    let statusText: string;
    if (c.installed) {
      const ver = c.version ? ` (${c.version})` : "";
      statusText = `${t.success("✓ Installed")}${ver}`;
    } else if (c.nodeIssue) {
      statusText = t.warning(`⚠ ${c.nodeIssue}`);
    } else {
      statusText = t.muted("○ Not installed");
    }

    console.log(`  ${t.primary(t.bold(c.displayName))}${defBadge}`);
    console.log(`    ${t.muted("Status:")}       ${statusText}`);
    if (c.path) {
      console.log(`    ${t.muted("Path:")}         ${t.muted(c.path)}`);
    }
    console.log(`    ${t.muted("Description:")}  ${c.description}`);
    if (c.installed) {
      console.log(`    ${t.muted("Run:")}          ${t.secondary(`pontis ${c.name}`)}`);
    } else {
      console.log(`    ${t.muted("Install:")}      ${t.accent(`pontis install ${c.name}`)}`);
    }
    console.log();
  }

  badge("muted", "Quick start: pontis <client> (e.g. pontis claude)");
  badge("muted", "Set default: pontis clients default <client>");
  console.log();
}

/**
 * Set the default client to launch with `pontis`.
 */
export function cmdClientsDefault(clientName: string): void {
  const normalized = clientName.toLowerCase().trim() as ClientName | "server";
  if (normalized !== "server" && !ALL_CLIENTS.includes(normalized as ClientName)) {
    badge("error", `Unknown client "${clientName}". Valid: ${ALL_CLIENTS.join(", ")}, server`);
    process.exit(1);
  }

  savePreferences({ defaultClient: normalized });
  const displayName = normalized === "server" ? "Server Mode" : CLIENTS[normalized as ClientName]?.name;
  badge("success", `Default client set to ${t.primary(displayName)}`);
}

/**
 * Interactive client manager.
 */
export async function cmdClientsInteractive(): Promise<void> {
  const prefs = getPreferences();
  const defaultClient = prefs.defaultClient || "claude";
  const clients = getAllClientsInfo();

  section("Coding Agent CLIs");
  for (const c of clients) {
    const isDef = c.name === defaultClient ? " ★" : "";
    const status = c.installed
      ? t.success(`✓ Installed${c.version ? ` (${c.version})` : ""}`)
      : t.muted("○ Not installed");
    kv(`${c.displayName}${isDef}`, status);
  }
  console.log();

  const missing = clients.filter((c) => !c.installed);

  const choices = [
    `${t.primary("View detailed client information")}`,
    `${t.primary("Set default launch client")}`,
    ...(missing.length > 0
      ? [`${t.primary("Install missing client(s)")}`]
      : []),
    `${t.muted("Back")}`,
  ];

  const res = await select("Choose an action", choices, { allowCustom: false, defaultIndex: 0 });

  switch (res.index) {
    case 0:
      cmdClientsList();
      break;
    case 1: {
      const clientChoices = ALL_CLIENTS.map((name) => {
        const def = CLIENTS[name];
        const isDef = name === defaultClient ? " (current default)" : "";
        return `${def.name}${isDef}`;
      });
      clientChoices.push("Server Mode (Proxy only)");

      const clientRes = await select("Choose default client", clientChoices, { allowCustom: false, defaultIndex: 0 });
      const selectedName = clientRes.index === ALL_CLIENTS.length ? "server" : ALL_CLIENTS[clientRes.index];
      cmdClientsDefault(selectedName);
      break;
    }
    case 2: {
      if (missing.length === 0) break;
      const installChoices = missing.map((c) => `Install ${c.displayName}`);
      if (missing.length > 1) installChoices.push("Install all missing");
      installChoices.push("Cancel");

      const installRes = await select("Select client to install", installChoices, { allowCustom: false });
      if (installRes.index < missing.length) {
        await installClient(missing[installRes.index].name, { interactive: false });
      } else if (installRes.index === missing.length && missing.length > 1) {
        for (const m of missing) {
          await installClient(m.name, { interactive: false });
        }
      }
      break;
    }
  }
}
