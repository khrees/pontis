/**
 * Codex network redirect helpers.
 *
 * To intercept Codex's WebSocket/HTTPS traffic to `api.openai.com`, we:
 * 1. Resolve the real IP of `api.openai.com` so we can proxy unknown requests
 * 2. Pin `api.openai.com` → `127.0.0.1` via `/etc/hosts`
 * 3. Use pf to redirect `:443` → `:8443` (Pontis TLS server)
 *
 * All operations require sudo and are interactive.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve4 } from "node:dns/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { badge } from "./ui";

const HOSTS_FILE = "/etc/hosts";
const PF_ANCHOR = "pontis";
const REDIRECT_PORT = 8443;

// Marker comment so we can find and remove our /etc/hosts entry
const HOSTS_MARKER = "# pontis codex redirect";

// PID lockfile to detect stale redirects from crashed sessions
const PONTIS_DIR = join(homedir(), ".pontis");
const REDIRECT_PID_FILE = join(PONTIS_DIR, "codex-redirect.pid");

/**
 * Resolve the real IP address of api.openai.com using direct DNS
 * (bypassing /etc/hosts) so the proxy can forward unrecognised requests
 * to the actual OpenAI servers.
 *
 * Uses `dns.resolve4` which queries DNS directly, unlike `dns.lookup`
 * which uses the OS resolver (and thus respects /etc/hosts).
 */
export async function resolveOpenAiRealIps(): Promise<string[]> {
  try {
    const addrs = await resolve4("api.openai.com");
    return addrs;
  } catch {
    // Fallback: well-known IPs for api.openai.com
    return ["172.66.0.243", "162.159.140.245"];
  }
}

/**
 * Add `127.0.0.1 api.openai.com` to /etc/hosts (via sudo).
 * Returns true if the entry was added, false if it already exists.
 */
export function addHostsEntry(): boolean {
  if (!existsSync(HOSTS_FILE)) return false;

  const content = readFileSync(HOSTS_FILE, "utf-8");
  if (content.includes("api.openai.com") && content.includes(HOSTS_MARKER)) {
    badge("muted", "Hosts entry for api.openai.com already exists");
    return false;
  }

  try {
    execSync(
      `sudo sh -c 'echo "127.0.0.1 api.openai.com ${HOSTS_MARKER}" >> ${HOSTS_FILE}'`,
      { stdio: "inherit" },
    );
    badge("muted", "Added api.openai.com → 127.0.0.1 to /etc/hosts");
    return true;
  } catch {
    badge("warning", "Could not add hosts entry (sudo may have been declined)");
    return false;
  }
}

/**
 * Remove our api.openai.com entry from /etc/hosts (via sudo).
 */
export function removeHostsEntry(): void {
  if (!existsSync(HOSTS_FILE)) return;

  try {
    const content = readFileSync(HOSTS_FILE, "utf-8");
    const lines = content.split("\n").filter(
      (line) => !line.includes(HOSTS_MARKER),
    );
    if (lines.length !== content.split("\n").length) {
      // Write to temp file then sudo copy
      const tmp = "/tmp/pontis-hosts";
      writeFileSync(tmp, lines.join("\n") + "\n");
      execSync(`sudo cp "${tmp}" "${HOSTS_FILE}"`, { stdio: "inherit" });
      execSync(`rm -f "${tmp}"`);
    }
  } catch {
    // Best effort
  }
}

/**
 * Add a pf rdr rule to redirect api.openai.com:443 → localhost:REDIRECT_PORT
 * using a dedicated anchor so we can cleanly remove it later.
 *
 * Since pf resolves hostnames at rule-load time, we work in tandem with the
 * /etc/hosts entry: hosts pins api.openai.com → 127.0.0.1, then pf redirects
 * loopback :443 → :REDIRECT_PORT.
 */
export function addPfRule(): boolean {
  try {
    const rule =
      `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port ${REDIRECT_PORT}`;

    // Write the anchor file and load it
    const tmp = "/tmp/pontis-pf.conf";
    writeFileSync(tmp, `${rule}\n`);
    execSync(`sudo pfctl -a ${PF_ANCHOR} -f "${tmp}" 2>/dev/null`, {
      stdio: "inherit",
    });
    execSync(`rm -f "${tmp}"`);

    // Enable pf if not already running
    execSync(`sudo pfctl -e 2>/dev/null`, { stdio: "ignore" });

    badge("muted", `pf redirect: api.openai.com:443 → :${REDIRECT_PORT}`);
    return true;
  } catch {
    badge(
      "warning",
      "Could not add pf rule (sudo may have been declined)",
    );
    return false;
  }
}

/**
 * Remove our pf anchor, disabling the redirect.
 */
export function removePfRule(): void {
  try {
    execSync(`sudo pfctl -a ${PF_ANCHOR} -F all 2>/dev/null`, {
      stdio: "ignore",
    });
  } catch {
    // Best effort
  }
}

/**
 * Write the current PID to a lockfile so we can detect stale redirects
 * from sessions that crashed without cleaning up.
 */
function writePidFile(): void {
  try {
    if (!existsSync(PONTIS_DIR)) {
      execSync(`mkdir -p "${PONTIS_DIR}"`, { stdio: "ignore" });
    }
    writeFileSync(REDIRECT_PID_FILE, String(process.pid), { mode: 0o600 });
  } catch {
    // Best effort
  }
}

/**
 * Remove the PID lockfile.
 */
function removePidFile(): void {
  try {
    if (existsSync(REDIRECT_PID_FILE)) unlinkSync(REDIRECT_PID_FILE);
  } catch {
    // Best effort
  }
}

/**
 * Check if the PID lockfile points to a running process.
 * If the file exists but the PID is dead, the redirect is stale.
 */
export function isRedirectStale(): boolean {
  if (!existsSync(REDIRECT_PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(REDIRECT_PID_FILE, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return true;
    // Check if process is alive (signal 0)
    try {
      process.kill(pid, 0);
      return false; // process is alive
    } catch {
      return true; // process is dead → stale
    }
  } catch {
    return true;
  }
}

/**
 * Set up the full redirect: hosts entry + pf rule.
 * Also writes a PID lockfile for stale-detection.
 * Returns true if any part succeeded.
 */
export function setupCodexRedirect(): boolean {
  // If there's a stale lockfile, clean up leftover rules first
  if (isRedirectStale()) {
    badge("warning", "Detected stale redirect from a previous session — cleaning up...");
    ensureRedirectRemoved();
  }

  const hosts = addHostsEntry();
  const pf = addPfRule();
  const ok = hosts || pf;

  if (ok) writePidFile();
  return ok;
}

/**
 * Check whether the Pontis hosts entry is currently present in /etc/hosts.
 */
export function isHostsEntryActive(): boolean {
  if (!existsSync(HOSTS_FILE)) return false;
  const content = readFileSync(HOSTS_FILE, "utf-8");
  return content.includes(HOSTS_MARKER) && content.includes("api.openai.com");
}

/**
 * Check whether the Pontis pf anchor is loaded.
 */
export function isPfRuleActive(): boolean {
  try {
    const out = execSync(`sudo pfctl -a ${PF_ANCHOR} -s rules 2>/dev/null || true`, {
      stdio: "pipe",
    }).toString().trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * Tear down the redirect: pf rule + hosts entry.
 * Returns true if anything was cleaned up.
 */
export function teardownCodexRedirect(): boolean {
  let cleaned = false;
  if (isPfRuleActive()) {
    removePfRule();
    cleaned = true;
  }
  if (isHostsEntryActive()) {
    removeHostsEntry();
    cleaned = true;
  }
  return cleaned;
}

/**
 * Quick cleanup function that can be called unconditionally.
 * Safe to call even if no redirect is active.
 */
export function ensureRedirectRemoved(): void {
  removePfRule();
  removeHostsEntry();
  removePidFile();
}

/**
 * Quick diagnostic: check whether api.openai.com resolves to 127.0.0.1
 * (indicating a stale hosts entry). Returns true if it does.
 */
export function isApiOpenaiMisdirected(): boolean {
  if (!existsSync(HOSTS_FILE)) return false;
  const content = readFileSync(HOSTS_FILE, "utf-8");
  // Look for any line that maps api.openai.com to a loopback address
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const ip = parts[0];
      const hostnames = parts.slice(1);
      if (
        hostnames.includes("api.openai.com") &&
        (ip === "127.0.0.1" || ip === "127.0.0.1" || ip === "0.0.0.0" || ip === "::1")
      ) {
        return true;
      }
    }
  }
  return false;
}
