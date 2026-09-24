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
  getCloudflareConfigSaved,
  getOpenCodeApiKey,
  getGoogleAuthToken,
  normalizeProvider,
  resolveActiveProviderAndModel,
  getDefaultModelForProvider,
  isModelCompatibleWithProvider,
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
import { fetchOpenCodeModelsGrouped } from "./provider-opencode";
import { isFreeOpenCodeModel } from "../opencode-models";
import {
  fetchLocalModels,
  fetchOllamaRegistryModels,
  categorizeLocalModels,
  KNOWN_OLLAMA_MODELS,
} from "./provider-local";
import {
  fetchCloudflareModels,
  KNOWN_CLOUDFLARE_MODELS,
  categorizeCloudflareModels,
} from "./provider-cloudflare";
import { fetchGoogleModels } from "./provider-google";
import { PORT, PROXY_URL } from "./proxy-manager";
import {
  ALL_CLIENTS,
  CLIENTS,
  isInstalled,
  checkAll,
  installClient,
  normalizeClientName,
  closestClientName,
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

const program = new Command();

program
  .name("pontis")
  .version(VERSION)
  .description(
    "Universal AI gateway & runtime launcher bridging Claude Code, Codex CLI, OpenCode, Pi, Hermes Agent, Google Gemini, Cloudflare Workers AI, and local LLMs",
  )
  .option("--json", "Output in JSON format (for scripting)");

function addPontisOptions(cmd: Command) {
  return cmd
    .option("-m, --model <name>", "Model ID (e.g. gemini-2.5-flash, mimo-v2.5-free)")
    .option("-p, --provider <type>", "Provider: google | opencode | local | cloudflare")
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

addPontisOptions(
  program
    .command("hermes")
    .description("Start proxy and launch Hermes Agent with configured model")
    .allowUnknownOption(true)
    .allowExcessArguments(true),
).action((opts) => {
  runWithConfig("hermes", opts, extractChildArgs("hermes")).catch((e) => {
    console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
    process.exit(1);
  });
});

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
  .description("Add or update API key for a provider (google, opencode, cloudflare, local)")
  .action(async (provider, key) => {
    await cmdAuthSet(provider, key);
  });

authCmd
  .command("remove [provider]")
  .alias("delete")
  .description("Remove credentials for a provider (google, opencode, cloudflare, local, all)")
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
      const names: ClientName[] = clients.includes("all")
        ? ALL_CLIENTS
        : (clients.map((c: string) => normalizeClientName(c) || (c as ClientName)));
      let hasUnknown = false;
      for (const name of names) {
        if (!CLIENTS[name]) {
          const suggestion = closestClientName(name);
          badge("error", `Unknown client: ${name}${suggestion ? ` — did you mean "${suggestion}"?` : ""}`);
          hasUnknown = true;
          continue;
        }
        if (isInstalled(name)) {
          badge("muted", `${CLIENTS[name]?.name || name} is already installed`);
          continue;
        }
        await installClient(name, { interactive: false });
      }
      if (hasUnknown) process.exit(1);
    }
  });

program
  .command("list")
  .description("List supported coding agent CLIs (alias to: pontis clients list)")
  .option("--json", "Output in JSON format")
  .action((opts) => {
    cmdClientsList(opts);
  });

program
  .command("install")
  .description("Install or check coding agent CLI tools")
  .argument("[clients...]", "Client(s) to install (claude, codex, hermes, opencode, pi, or 'all')")
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
        const names: ClientName[] = clients.length > 0
          ? (clients.includes("all") ? ALL_CLIENTS : clients.map((c) => normalizeClientName(c) || (c as ClientName)))
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

      const names: ClientName[] | null = clients.length > 0
        ? (clients.includes("all") ? ALL_CLIENTS : clients.map((c) => normalizeClientName(c) || (c as ClientName)))
        : null;

      if (names) {
        let hasUnknown = false;
        for (const name of names) {
          if (!CLIENTS[name]) {
            const suggestion = closestClientName(name);
            badge("error", `Unknown client: ${name}${suggestion ? ` — did you mean "${suggestion}"?` : ""}`);
            hasUnknown = true;
            continue;
          }
          if (isInstalled(name)) {
            badge("muted", `${CLIENTS[name]?.name || name} already installed — skipping`);
            continue;
          }
          await installClient(name, { interactive: false });
        }
        if (hasUnknown) process.exit(1);
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
    badge("muted", "Set value: pontis config set <key> <value>");
    badge("muted", "Keys: client | provider | model | endpoint");
  });

configCmd
  .command("set <key> <value>")
  .description("Set a preference value (e.g. pontis config set model deepseek-v4-flash-free)")
  .action((key, value) => {
    const normKey = key.toLowerCase().trim();
    switch (normKey) {
      case "client": {
        const lowerVal = value.toLowerCase().trim();
        const clientVal = lowerVal === "server" ? "server" : normalizeClientName(value);
        if (!clientVal) {
          badge(
            "error",
            `Unknown client "${value}". Valid clients: claude, codex, hermes, opencode, pi, server`,
          );
          process.exit(1);
        }
        savePreferences({ defaultClient: clientVal as ClientName | "server" });
        badge("success", `Default client set to "${clientVal}"`);
        break;
      }
      case "provider": {
        const provider = normalizeProvider(value.toLowerCase());
        if (!provider) {
          badge("error", `Unknown provider "${value}". Valid providers: google, opencode, local, cloudflare`);
          process.exit(1);
        }
        const prefs = getPreferences();
        let newModel = prefs.providerModels?.[provider] || prefs.defaultModel;
        if (!isModelCompatibleWithProvider(newModel, provider)) {
          newModel = getDefaultModelForProvider(provider);
        }
        const providerModels = { ...(prefs.providerModels || {}), [provider]: newModel };
        savePreferences({ defaultProvider: provider, defaultModel: newModel, providerModels });
        badge("success", `Default provider set to "${provider}" (active model: ${newModel})`);
        break;
      }
      case "model": {
        const prefs = getPreferences();
        const activeProvider = prefs.defaultProvider || "opencode";
        const providerModels = { ...(prefs.providerModels || {}), [activeProvider]: value };
        savePreferences({ defaultModel: value, providerModels });
        badge("success", `Default model set to "${value}"`);
        break;
      }
      case "endpoint":
        savePreferences({ localEndpoint: value });
        badge("success", `Local endpoint set to "${value}"`);
        break;
      default:
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

program
  .command("models")
  .description("List available models from the configured provider")
  .option("-p, --provider <type>", "Provider: google | opencode | local | cloudflare")
  .option("-u, --upstream <url>", "Upstream endpoint URL")
  .action(async (opts) => {
    try {
      const prefs = getPreferences();
      const { provider } = resolveActiveProviderAndModel({
        provider: opts.provider,
        upstream: opts.upstream,
      });

      let upstreamUrl = opts.upstream || process.env.PONTIS_UPSTREAM_URL || (provider === "local" ? prefs.localEndpoint : undefined);

      switch (provider) {
        case "google": {
          const apiKey = opts.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || getGoogleAuthToken() || "";
          if (!apiKey) {
            const msg = "No Google credentials found. Run: pontis auth set google";
            if (jsonMode) outputJsonError("missing_api_key", msg);
            badge("error", msg);
            process.exit(1);
          }
          const spin = jsonMode ? null : createSpinner("Fetching models from Google AI...");
          const models = await fetchGoogleModels(apiKey);
          if (spin) {
            spin.stop(
              models.length > 0
                ? { type: "success", text: `Found ${models.length} model${models.length === 1 ? "" : "s"}` }
                : { type: "warning", text: "No models returned from Google" },
            );
          }
          if (jsonMode) {
            outputJson({
              provider: "google",
              models: models.map((id) => ({ id })),
            });
          }
          if (models.length === 0) {
            badge("warning", "No models found. Check your API key.");
          } else {
            section("Available Google (Gemini) Models");
            for (const m of models) kv("Model", t.primary(m));
          }
          break;
        }
        case "cloudflare": {
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
          const rawModels = await fetchCloudflareModels(accountId, apiToken);
          const modelList = rawModels.length > 0 ? rawModels : [...KNOWN_CLOUDFLARE_MODELS];
          const groups = categorizeCloudflareModels(modelList);

          if (spin) {
            spin.stop(
              rawModels.length > 0
                ? {
                    type: "success",
                    text: `Found ${rawModels.length} Cloudflare model${rawModels.length === 1 ? "" : "s"}`,
                  }
                : { type: "warning", text: "No models returned from Cloudflare API — showing known catalog" },
            );
          }
          if (jsonMode) {
            outputJson({
              provider: "cloudflare",
              groups: {
                free: groups.free.map((id) => ({ id })),
                frontier: groups.frontier.map((id) => ({ id })),
                chinese: groups.chinese.map((id) => ({ id })),
                others: groups.others.map((id) => ({ id })),
              },
              models: groups.all.map((id) => ({ id })),
            });
          }
          if (rawModels.length === 0) {
            badge(
              "warning",
              "No models returned from Cloudflare API. Showing verified 2026 catalog.",
            );
          }

          if (groups.free.length > 0) {
            section(`Free Models (${groups.free.length}) · Workers Free allocation`);
            for (const m of groups.free) kv("Free", t.success(m));
          }

          if (groups.frontier.length > 0) {
            section(`Frontier Models (${groups.frontier.length}) · Flagship reasoning & coding`);
            for (const m of groups.frontier) kv("Frontier", t.primary(m));
          }

          if (groups.chinese.length > 0) {
            section(`Chinese Models (${groups.chinese.length}) · DeepSeek, GLM, Kimi, Qwen`);
            for (const m of groups.chinese) kv("Chinese", t.accent(m));
          }

          if (groups.others.length > 0) {
            section(`Others Models (${groups.others.length}) · Meta, Google, Mistral, NVIDIA, IBM`);
            for (const m of groups.others) kv("Others", t.dim(m));
          }
          break;
        }
        case "opencode": {
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
            : createSpinner("Fetching live available models from OpenCode...");
          const groups = await fetchOpenCodeModelsGrouped(apiKey);
          const total = groups.combined.length;
          if (spin)
            spin.stop(
              total > 0
                ? { type: "success", text: `${total} OpenCode models available (Inference API)` }
                : { type: "warning", text: "No models found" },
            );
          if (jsonMode) {
            outputJson({
              provider: "opencode",
              free: groups.free.map((id) => ({ id, free: true })),
              frontier: groups.frontier.map((id) => ({ id, free: false })),
              chinese: groups.chinese.map((id) => ({ id, free: false })),
              others: groups.others.map((id) => ({ id, free: false })),
              zen: groups.zen.map((id) => ({ id, free: isFreeOpenCodeModel(id) })),
              go: groups.go.map((id) => ({ id, free: false })),
              models: groups.combined.map((id) => ({ id, free: isFreeOpenCodeModel(id) })),
            });
          }
          if (total === 0) {
            badge("warning", "No models found. Check your API key.");
          } else {
            if (groups.free.length > 0) {
              section(`Free (${groups.free.length})`);
              for (const m of groups.free) kv("Model", t.primary(m));
            }
            if (groups.frontier.length > 0) {
              section(`Frontier (${groups.frontier.length})`);
              for (const m of groups.frontier) kv("Model", t.primary(m));
            }
            if (groups.chinese.length > 0) {
              section(`Chinese (${groups.chinese.length})`);
              for (const m of groups.chinese) kv("Model", t.primary(m));
            }
            if (groups.others.length > 0) {
              section(`Others (${groups.others.length})`);
              for (const m of groups.others) kv("Model", t.primary(m));
            }
          }
          break;
        }
        default: {
          if (!upstreamUrl) {
            upstreamUrl = "http://localhost:11434/v1";
          }
          const apiKey =
            process.env.LOCAL_API_KEY || process.env.OPENAI_API_KEY || "";
          const spin = jsonMode
            ? null
            : createSpinner(`Scanning models at ${upstreamUrl}...`);
          const rawModels = await fetchLocalModels(upstreamUrl, apiKey);
          const models = rawModels.length > 0 ? rawModels : (await fetchOllamaRegistryModels());
          const effectiveModels = models.length > 0 ? models : [...KNOWN_OLLAMA_MODELS];
          const groups = categorizeLocalModels(effectiveModels);

          if (spin)
            spin.stop(
              rawModels.length > 0
                ? {
                    type: "success",
                    text: `Found ${rawModels.length} local model${rawModels.length === 1 ? "" : "s"}`,
                  }
                : models.length > 0
                  ? {
                      type: "success",
                      text: `No local models installed — fetched ${models.length} from Ollama registry`,
                    }
                  : { type: "warning", text: "No models returned from upstream — showing known Ollama catalog" },
            );
          if (jsonMode) {
            outputJson({
              provider: "local",
              upstream: upstreamUrl,
              groups: {
                free: groups.free.map((id) => ({ id })),
                frontier: groups.frontier.map((id) => ({ id })),
                chinese: groups.chinese.map((id) => ({ id })),
                others: groups.others.map((id) => ({ id })),
              },
              models: groups.all.map((id) => ({ id })),
            });
          }
          if (rawModels.length === 0 && models.length === 0) {
            badge("warning", "No models returned from upstream. Is your local engine running? Showing known catalog.");
          }

          if (groups.free.length > 0) {
            section(`Free Models (${groups.free.length}) · Locally stored & run (0 token cost)`);
            for (const m of groups.free) kv("Free", t.success(m));
          }

          if (groups.frontier.length > 0) {
            section(`Frontier Models (${groups.frontier.length}) · Flagship reasoning & coding`);
            for (const m of groups.frontier) kv("Frontier", t.primary(m));
          }

          if (groups.chinese.length > 0) {
            section(`Chinese Models (${groups.chinese.length}) · Qwen, DeepSeek, Kimi, MiniMax, GLM`);
            for (const m of groups.chinese) kv("Chinese", t.accent(m));
          }

          if (groups.others.length > 0) {
            section(`Others Models (${groups.others.length}) · Meta, Google, Mistral, Microsoft, NVIDIA`);
            for (const m of groups.others) kv("Others", t.dim(m));
          }
          break;
        }
      }
    } catch (e: any) {
      if (jsonMode) outputJsonError("fetch_failed", e.message || String(e));
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    }
  });

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
      const { provider, model } = resolveActiveProviderAndModel();
      let upstream = process.env.PONTIS_UPSTREAM_URL;
      if (!upstream) {
        switch (provider) {
          case "google":
            upstream = "(Google Gemini API)";
            break;
          case "local":
            upstream = prefs.localEndpoint || "http://localhost:11434/v1";
            break;
          case "cloudflare":
            upstream = "(Cloudflare AI Gateway)";
            break;
          default:
            upstream = "(default OpenCode Zen)";
            break;
        }
      }
      const format = process.env.PONTIS_UPSTREAM_FORMAT || "openai";
      const debug = process.env.PONTIS_DEBUG === "true";
      const keyExists =
        provider === "cloudflare"
          ? existsSync(CLOUDFLARE_CONFIG_FILE)
          : provider === "google"
            ? getGoogleAuthToken() !== null
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
        return;
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

      section("Active Configuration");
      kv("Default Client", t.primary(prefs.defaultClient || "claude"));
      kv("Provider", t.primary(provider));
      kv("Model", t.primary(model));
      kv("Upstream", t.muted(upstream));
      kv("Format", format);
      kv("API Key", keyExists ? t.success("saved") : t.warning("not found"));
      kv("Debug", debug ? t.success("on") : t.muted("off"));
      kv("Logs", t.muted(PROXY_LOG));


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
      badge("muted", "Manage clients: pontis clients");
      badge("muted", "Manage keys:    pontis auth");
    } catch (e: any) {
      if (jsonMode) outputJsonError("status_failed", e.message || String(e));
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    }
  });


program.action(() => {
  const opts = program.opts();
  const env: PontisEnv = {};
  if (opts.model || process.env.PONTIS_MODEL)
    env.model = opts.model || process.env.PONTIS_MODEL;
  if (opts.provider || process.env.PONTIS_PROVIDER)
    env.provider =
      opts.provider ||
      (process.env.PONTIS_PROVIDER as "opencode" | "local" | "cloudflare" | "google");
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

function extractChildArgs(...commands: string[]): string[] {
  const args = process.argv.slice(2);
  let subIdx = -1;
  for (const cmd of commands) {
    const idx = args.indexOf(cmd);
    if (idx >= 0) {
      subIdx = idx;
      break;
    }
  }
  if (subIdx < 0) return [];
  const result: string[] = [];
  for (let i = subIdx + 1; i < args.length; i++) {
    const arg = args[i];

    // Exact match: --flag value (two separate args)
    if (KNOWN_PONTIS_FLAGS.has(arg)) {
      i++; // skip the value arg too
      continue;
    }

    // Combined form: --flag=value (single arg)
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0 && KNOWN_PONTIS_FLAGS.has(arg.slice(0, eqIdx))) {
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

// Platform gate: Pontis shells out to Unix-only tools (`which`, `lsof`,
// `:`-style PATH joins). Fail fast on Windows with a clear message instead of a
// confusing "'which' is not recognized" deep inside a flow.
if (process.platform === "win32") {
  badge("error", "Pontis is not supported on Windows yet.");
  console.log(
    `  ${t.muted("Pontis relies on Unix-only tooling (lsof, which, sh). Run it inside WSL: https://aka.ms/wsl")}`,
  );
  process.exit(1);
}

program.parse(process.argv);
