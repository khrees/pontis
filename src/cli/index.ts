#!/usr/bin/env node

/**
 * Pontis CLI — entrypoint routing requests to client launchers, providers, auth, and preferences.
 */

import { Command } from "commander";
import { existsSync } from "node:fs";
import { runInteractiveWizard, runWithConfig } from "./wizard";
import {
  CLOUDFLARE_CONFIG_FILE,
  PROXY_LOG,
  FALLBACK_MODELS,
  CLOUDFLARE_FALLBACK_MODELS,
  getCloudflareConfigSaved,
  getOpenCodeApiKey,
  type PontisEnv,
} from "./config";
import {
  section,
  badge,
  kv,
  jsonMode,
  outputJson,
  outputJsonError,
  t,
  SYM,
  VERSION,
  createSpinner,
} from "./ui";
import { fetchWorkingOpenCodeModels } from "./provider-opencode";
import { fetchLocalModels } from "./provider-local";
import { fetchCloudflareModels } from "./provider-cloudflare";
import { PORT, PROXY_URL } from "./proxy-manager";
import {
  ALL_CLIENTS,
  CLIENTS,
  isInstalled,
  checkAll,
  installClient,
  type ClientName,
  cmdClientsList,
  cmdClientsDefault,
  cmdClientsInteractive,
  getAllClientsInfo,
} from "./install-engine";
import {
  cmdAuthStatus,
  cmdAuthSet,
  cmdAuthRemove,
  cmdAuthClear,
  cmdAuthInteractive,
} from "./auth";
import {
  getPreferences,
  savePreferences,
  resetPreferences,
} from "./preferences";
import { isHostsEntryActive, isPfRuleActive } from "./codex-redirect";

const program = new Command();

program
  .name("pontis")
  .version(VERSION)
  .description(
    "Universal AI gateway & runtime launcher bridging Claude Code, Codex CLI, OpenCode, Pi, Cloudflare Workers AI, and local LLMs",
  )
  .option("--json", "Output in JSON format (for scripting)");

function addPontisOptions(cmd: Command) {
  return cmd
    .option("-m, --model <name>", "Model ID (e.g. mimo-v2.5-free)")
    .option("-p, --provider <type>", "Provider: opencode | local | cloudflare")
    .option("-k, --api-key <key>", "API key for the provider")
    .option("-u, --upstream <url>", "Upstream endpoint URL")
    .option(
      "-f, --format <format>",
      "Upstream format (openai | anthropic | openai-completions)",
    )
    .option(
      "--install",
      "Auto-install client tool if missing (default: prompt)",
    )
    .option(
      "--no-install",
      "Skip auto-install, error if client tool is missing",
    );
}

// ──────────────────────────────────────────────
//  Client Subcommands (Direct Launchers)
// ──────────────────────────────────────────────

// Subcommand: claude
addPontisOptions(
  program
    .command("claude")
    .description("Start proxy and launch Claude Code with configured model")
    .allowUnknownOption(true)
    .allowExcessArguments(true),
).action((opts) => {
  runWithConfig("claude", opts, extractChildArgs("claude")).catch((e) => {
    console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
    process.exit(1);
  });
});

// Subcommand: codex
addPontisOptions(
  program
    .command("codex")
    .description("Start proxy and launch Codex CLI with configured model")
    .allowUnknownOption(true)
    .allowExcessArguments(true),
).action((opts) => {
  runWithConfig("codex", opts, extractChildArgs("codex")).catch((e) => {
    console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
    process.exit(1);
  });
});

// Subcommand: opencode
addPontisOptions(
  program
    .command("opencode")
    .description("Start proxy and launch OpenCode with configured model")
    .allowUnknownOption(true)
    .allowExcessArguments(true),
).action((opts) => {
  runWithConfig("opencode", opts, extractChildArgs("opencode")).catch((e) => {
    console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
    process.exit(1);
  });
});

// Subcommand: pi
addPontisOptions(
  program
    .command("pi")
    .description("Start proxy and launch Pi coding agent with configured model")
    .allowUnknownOption(true)
    .allowExcessArguments(true),
).action((opts) => {
  runWithConfig("pi", opts, extractChildArgs("pi")).catch((e) => {
    console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
    process.exit(1);
  });
});

// Subcommand: server
addPontisOptions(
  program
    .command("server")
    .description("Start the proxy server without launching a client"),
).action((opts) => {
  runWithConfig("server", opts, []).catch((e) => {
    console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
    process.exit(1);
  });
});

// ──────────────────────────────────────────────
//  Authentication Management
// ──────────────────────────────────────────────

const authCmd = program
  .command("auth")
  .description("Manage provider API keys and credentials")
  .action(async () => {
    await cmdAuthInteractive();
  });

authCmd
  .command("list")
  .alias("status")
  .description("List saved authentication credentials and keys")
  .option("--json", "Output in JSON format")
  .action((opts) => {
    cmdAuthStatus(opts);
  });

authCmd
  .command("set [provider] [key]")
  .alias("add")
  .description("Add or update API key for a provider (opencode, cloudflare, local)")
  .action(async (provider, key) => {
    await cmdAuthSet(provider, key);
  });

authCmd
  .command("remove [provider]")
  .alias("delete")
  .description("Remove credentials for a provider (opencode, cloudflare, local, all)")
  .action(async (provider) => {
    await cmdAuthRemove(provider);
  });

authCmd
  .command("clear")
  .description("Clear all saved API keys and credentials")
  .action(async () => {
    await cmdAuthClear();
  });

// Aliases for auth
program
  .command("login [provider] [key]")
  .description("Log in / set API key for a provider")
  .action(async (provider, key) => {
    await cmdAuthSet(provider, key);
  });

program
  .command("logout [provider]")
  .description("Remove saved API key / credentials for a provider")
  .action(async (provider) => {
    await cmdAuthRemove(provider);
  });

program
  .command("update-key [key]")
  .description("Update OpenCode API key (alias to: pontis auth set opencode)")
  .action(async (key) => {
    await cmdAuthSet("opencode", key);
  });

program
  .command("reset-cloudflare")
  .description("Clear saved Cloudflare credentials (alias to: pontis auth remove cloudflare)")
  .action(async () => {
    await cmdAuthRemove("cloudflare");
  });

// ──────────────────────────────────────────────
//  Clients Management & Listing
// ──────────────────────────────────────────────

const clientsCmd = program
  .command("clients")
  .description("List and manage coding agent CLIs (Claude, Codex, OpenCode, Pi)")
  .action(async () => {
    await cmdClientsInteractive();
  });

clientsCmd
  .command("list")
  .description("List all supported coding agent CLIs and installation status")
  .option("--json", "Output in JSON format")
  .action((opts) => {
    cmdClientsList(opts);
  });

clientsCmd
  .command("default <client>")
  .description("Set the default coding agent CLI to launch with `pontis`")
  .action((client) => {
    cmdClientsDefault(client);
  });

clientsCmd
  .command("install [clients...]")
  .description("Install coding agent CLI tools")
  .action(async (clients) => {
    if (clients.length === 0) {
      await cmdClientsInteractive();
    } else {
      const names = clients.includes("all") ? ALL_CLIENTS : (clients as ClientName[]);
      for (const name of names) {
        if (isInstalled(name)) {
          badge("muted", `${CLIENTS[name]?.name || name} is already installed`);
          continue;
        }
        await installClient(name, { interactive: false });
      }
    }
  });

// Top-level `pontis list` alias
program
  .command("list")
  .description("List supported coding agent CLIs (alias to: pontis clients list)")
  .option("--json", "Output in JSON format")
  .action((opts) => {
    cmdClientsList(opts);
  });

// Subcommand: install (for backward compatibility)
program
  .command("install")
  .description("Install or check coding agent CLI tools")
  .argument("[clients...]", "Client(s) to install (claude, codex, opencode, pi, or 'all')")
  .option("--list", "Show installed clients and versions")
  .option("--check", "Exit 0 if all specified clients are installed, 1 if missing")
  .option("--json", "Output in JSON format")
  .action(async (clients: string[], opts: { list?: boolean; check?: boolean; json?: boolean }) => {
    try {
      if (opts.list) {
        cmdClientsList(opts);
        return;
      }

      if (opts.check) {
        const names = clients.length > 0
          ? (clients.includes("all") ? ALL_CLIENTS : clients as ClientName[])
          : ALL_CLIENTS;
        const status = checkAll();
        const missing = names.filter((n) => !status[n as ClientName]);
        if (missing.length > 0) {
          if (opts.json || jsonMode) {
            outputJsonError("missing_clients", `Missing: ${missing.join(", ")}`);
          }
          for (const name of missing) {
            badge("error", `${CLIENTS[name as ClientName]?.name || name} is not installed`);
          }
          process.exit(1);
        }
        if (opts.json || jsonMode) {
          outputJson({ ok: true, clients: names });
        }
        badge("success", "All specified clients are installed");
        return;
      }

      const names = clients.length > 0
        ? (clients.includes("all") ? ALL_CLIENTS : clients as ClientName[])
        : null;

      if (names) {
        for (const name of names) {
          if (isInstalled(name)) {
            badge("muted", `${CLIENTS[name]?.name || name} already installed — skipping`);
            continue;
          }
          await installClient(name, { interactive: false });
        }
        if (opts.json || jsonMode) {
          const status = checkAll();
          outputJson({ clients: names.map((n) => ({ name: n, installed: status[n] })) });
        }
      } else {
        await cmdClientsInteractive();
      }
    } catch (e: any) {
      if (jsonMode) outputJsonError("install_failed", e.message || String(e));
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
//  User Preferences & Configuration
// ──────────────────────────────────────────────

const configCmd = program
  .command("config")
  .description("View and manage Pontis preferences (default client, provider, model)")
  .action(() => {
    const prefs = getPreferences();
    section("Pontis Preferences");
    kv("Default Client", t.primary(prefs.defaultClient || "claude"));
    kv("Default Provider", t.primary(prefs.defaultProvider || "opencode"));
    kv("Default Model", t.primary(prefs.defaultModel || "(provider default)"));
    if (prefs.localEndpoint) kv("Local Endpoint", t.muted(prefs.localEndpoint));
    console.log();
    badge("muted", "Set value: pontis config set <key> <value>");
    badge("muted", "Keys: client | provider | model | endpoint");
    console.log();
  });

configCmd
  .command("set <key> <value>")
  .description("Set a preference value (e.g. pontis config set model deepseek-v4-flash-free)")
  .action((key, value) => {
    const normKey = key.toLowerCase().trim();
    if (normKey === "client") {
      savePreferences({ defaultClient: value.toLowerCase() as ClientName | "server" });
      badge("success", `Default client set to "${value}"`);
    } else if (normKey === "provider") {
      savePreferences({ defaultProvider: value.toLowerCase() as any });
      badge("success", `Default provider set to "${value}"`);
    } else if (normKey === "model") {
      savePreferences({ defaultModel: value });
      badge("success", `Default model set to "${value}"`);
    } else if (normKey === "endpoint") {
      savePreferences({ localEndpoint: value });
      badge("success", `Local endpoint set to "${value}"`);
    } else {
      badge("error", `Unknown config key "${key}". Valid keys: client, provider, model, endpoint`);
      process.exit(1);
    }
  });

configCmd
  .command("reset")
  .description("Reset all user preferences to defaults")
  .action(() => {
    resetPreferences();
    badge("success", "Preferences reset to defaults");
  });

// ──────────────────────────────────────────────
//  Models Discovery
// ──────────────────────────────────────────────

program
  .command("models")
  .description("List available models from the configured provider")
  .option("-p, --provider <type>", "Provider: opencode | local | cloudflare")
  .option("-u, --upstream <url>", "Upstream endpoint URL")
  .action(async (opts) => {
    try {
      const prefs = getPreferences();
      const provider: "opencode" | "local" | "cloudflare" =
        opts.provider ||
        (process.env.PONTIS_PROVIDER as "opencode" | "local" | "cloudflare") ||
        prefs.defaultProvider ||
        (process.env.PONTIS_UPSTREAM_URL ? "local" : "opencode");

      let upstreamUrl = opts.upstream || process.env.PONTIS_UPSTREAM_URL || (provider === "local" ? prefs.localEndpoint : undefined);

      if (provider === "cloudflare") {
        const savedCf = getCloudflareConfigSaved();
        const apiToken =
          opts.apiKey || process.env.CLOUDFLARE_API_TOKEN || savedCf.apiToken;
        const accountId =
          process.env.CLOUDFLARE_ACCOUNT_ID || savedCf.accountId;
        if (!apiToken || !accountId) {
          const msg =
            "Cloudflare API Token and Account ID are required. Run: pontis auth set cloudflare";
          if (jsonMode) outputJsonError("missing_cloudflare_config", msg);
          badge("error", msg);
          process.exit(1);
        }
        const spin = jsonMode
          ? null
          : createSpinner("Fetching models from Cloudflare...");
        const models = await fetchCloudflareModels(accountId, apiToken);
        if (spin) {
          spin.stop(
            models.length > 0
              ? {
                  type: "success",
                  text: `Found ${models.length} model${models.length === 1 ? "" : "s"}`,
                }
              : { type: "warning", text: "No models returned from Cloudflare" },
          );
        }
        if (jsonMode) {
          outputJson({
            provider: "cloudflare",
            models: models.map((id) => ({ id })),
          });
        }
        if (models.length === 0) {
          badge(
            "warning",
            "No models found. Check your API key and Account ID.",
          );
        } else {
          section("Available Cloudflare Models");
          for (const m of models) kv("Model", t.primary(m));
        }
      } else if (provider === "opencode") {
        const apiKey = getOpenCodeApiKey() || "";
        if (!apiKey) {
          if (jsonMode)
            outputJsonError(
              "missing_api_key",
              "No OpenCode API key found. Set OPENCODE_API_KEY or run: pontis auth set opencode",
            );
          badge(
            "error",
            "No OpenCode API key found. Run: pontis auth set opencode",
          );
          process.exit(1);
        }
        const spin = jsonMode
          ? null
          : createSpinner("Fetching models from OpenCode...");
        const models = await fetchWorkingOpenCodeModels(apiKey);
        if (spin)
          spin.stop(
            models.length > 0
              ? {
                  type: "success",
                  text: `${models.length} model${models.length === 1 ? "" : "s"} available`,
                }
              : { type: "warning", text: "No models found" },
          );
        if (jsonMode) {
          outputJson({
            provider: "opencode",
            models: models.map((id) => ({ id })),
          });
        }
        if (models.length === 0) {
          badge("warning", "No models found. Check your API key.");
        } else {
          section("Available OpenCode Models");
          for (const m of models) kv("Model", t.primary(m));
        }
      } else {
        if (!upstreamUrl) {
          upstreamUrl = "http://localhost:11434/v1";
        }
        const apiKey =
          process.env.LOCAL_API_KEY || process.env.OPENAI_API_KEY || "";
        const spin = jsonMode
          ? null
          : createSpinner(`Scanning models at ${upstreamUrl}...`);
        const models = await fetchLocalModels(upstreamUrl, apiKey);
        if (spin)
          spin.stop(
            models.length > 0
              ? {
                  type: "success",
                  text: `Found ${models.length} model${models.length === 1 ? "" : "s"}`,
                }
              : { type: "warning", text: "No models returned from upstream" },
          );
        if (jsonMode) {
          outputJson({
            provider: "local",
            upstream: upstreamUrl,
            models: models.map((id) => ({ id })),
          });
        }
        if (models.length === 0) {
          badge("warning", "No models returned from upstream. Is your local engine running?");
        } else {
          section("Available Local Models");
          for (const m of models) kv("Model", t.primary(m));
        }
      }
    } catch (e: any) {
      if (jsonMode) outputJsonError("fetch_failed", e.message || String(e));
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────
//  Status Subcommand
// ──────────────────────────────────────────────

program
  .command("status")
  .description("Show current proxy, configuration, authentication, and client status")
  .action(async () => {
    try {
      let proxyRunning = false;
      const proxyPort = PORT;

      try {
        const res = await fetch(PROXY_URL + "/", {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) proxyRunning = true;
      } catch {}

      const prefs = getPreferences();
      const provider: string =
        process.env.PONTIS_PROVIDER ||
        prefs.defaultProvider ||
        (process.env.PONTIS_UPSTREAM_URL ? "local" : "opencode");
      const model =
        process.env.PONTIS_MODEL ||
        prefs.defaultModel ||
        (provider === "cloudflare"
          ? CLOUDFLARE_FALLBACK_MODELS[0]
          : FALLBACK_MODELS[0]);
      const upstream =
        process.env.PONTIS_UPSTREAM_URL ||
        prefs.localEndpoint ||
        (provider === "cloudflare"
          ? "(Cloudflare AI Gateway)"
          : "(default OpenCode Zen)");
      const format = process.env.PONTIS_UPSTREAM_FORMAT || "openai";
      const debug = process.env.PONTIS_DEBUG === "true";
      const keyExists =
        provider === "cloudflare"
          ? existsSync(CLOUDFLARE_CONFIG_FILE)
          : getOpenCodeApiKey() !== null;

      const clients = getAllClientsInfo();

      if (jsonMode) {
        outputJson({
          proxy: { running: proxyRunning, port: proxyPort, url: PROXY_URL },
          provider,
          model,
          upstream,
          format,
          debug,
          apiKeySaved: keyExists,
          logs: PROXY_LOG,
          preferences: prefs,
          clients: clients.map((c) => ({
            name: c.name,
            displayName: c.displayName,
            installed: c.installed,
            version: c.version,
            path: c.path,
          })),
        });
      }

      section("Pontis Status");

      if (proxyRunning) {
        badge("success", `Proxy running on ${t.secondary(PROXY_URL)}`);
      } else {
        badge(
          "warning",
          `Proxy not running (starts automatically on client launch or: ${t.secondary("pontis server")})`,
        );
      }

      console.log();
      section("Active Configuration");
      kv("Default Client", t.primary(prefs.defaultClient || "claude"));
      kv("Provider", t.primary(provider));
      kv("Model", t.primary(model));
      kv("Upstream", t.muted(upstream));
      kv("Format", format);
      kv("API Key", keyExists ? t.success("saved") : t.warning("not found"));
      kv("Debug", debug ? t.success("on") : t.muted("off"));
      kv("Logs", t.muted(PROXY_LOG));

      const hostsActive = isHostsEntryActive();
      const pfActive = isPfRuleActive();
      if (hostsActive || pfActive) {
        console.log();
        section("Codex Network Redirect");
        kv("Hosts entry", hostsActive ? t.warning("active") : t.muted("inactive"));
        kv("pf rule", pfActive ? t.warning("active") : t.muted("inactive"));
        badge("info", "Stale redirect rules may break codex login");
        badge("muted", "Clean up: sudo pontis cleanup-redirect");
      }
      console.log();

      section("Supported Coding Agent CLIs");
      for (const c of clients) {
        const isDef = c.name === (prefs.defaultClient || "claude") ? " ★" : "";
        if (c.installed) {
          const ver = c.version ? ` (${c.version})` : "";
          kv(`${c.displayName}${isDef}`, `${t.success("installed")}${t.muted(ver)}`);
        } else if (c.nodeIssue) {
          kv(`${c.displayName}${isDef}`, t.warning(c.nodeIssue));
        } else {
          kv(`${c.displayName}${isDef}`, t.muted("not installed"));
        }
      }
      console.log();
      badge("muted", "Manage clients: pontis clients");
      badge("muted", "Manage keys:    pontis auth");
      console.log();
    } catch (e: any) {
      if (jsonMode) outputJsonError("status_failed", e.message || String(e));
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    }
  });

// Subcommand: cleanup-redirect — remove stale Codex redirect rules
program
  .command("cleanup-redirect")
  .description("Remove stale /etc/hosts entry and pf rule for api.openai.com")
  .action(async () => {
    try {
      const hostsActive = isHostsEntryActive();
      const pfActive = isPfRuleActive();

      if (!hostsActive && !pfActive) {
        badge("info", "No stale redirect rules found — nothing to clean up.");
        return;
      }

      if (hostsActive) {
        badge("warning", "Stale hosts entry found for api.openai.com");
      }
      if (pfActive) {
        badge("warning", "Stale pf rule found for api.openai.com redirect");
      }

      console.log("  You may be prompted for your sudo password...\n");

      const { ensureRedirectRemoved } = await import("./codex-redirect");
      ensureRedirectRemoved();

      badge("success", "Redirect rules cleaned up.");
    } catch (e: any) {
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    }
  });

// Default (no subcommand): interactive wizard / Quick Launch
program.action(() => {
  const opts = program.opts();
  const env: PontisEnv = {};
  if (opts.model || process.env.PONTIS_MODEL)
    env.model = opts.model || process.env.PONTIS_MODEL;
  if (opts.provider || process.env.PONTIS_PROVIDER)
    env.provider =
      opts.provider ||
      (process.env.PONTIS_PROVIDER as "opencode" | "local" | "cloudflare");
  if (opts.apiKey) env.apiKey = opts.apiKey;

  runInteractiveWizard(env).catch((e) => {
    console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
    process.exit(1);
  });
});

const KNOWN_PONTIS_FLAGS = new Set([
  "-m",
  "--model",
  "-p",
  "--provider",
  "-k",
  "--api-key",
  "-u",
  "--upstream",
  "-f",
  "--format",
  "--json",
  "--install",
  "--no-install",
]);

function extractChildArgs(subcommand: string): string[] {
  const args = process.argv.slice(2);
  const subIdx = args.indexOf(subcommand);
  if (subIdx < 0) return [];
  const result: string[] = [];
  for (let i = subIdx + 1; i < args.length; i++) {
    const arg = args[i];
    if (KNOWN_PONTIS_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg === "--") {
      result.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--version" || arg === "-V" || arg === "--help" || arg === "-h")
      continue;
    result.push(arg);
  }
  return result;
}

program.parse(process.argv);
