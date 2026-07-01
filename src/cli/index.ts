#!/usr/bin/env node

/**
 * Pontis CLI — entrypoint routing requests to provider setup subfiles.
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
import { cmdUpdateKey, fetchWorkingOpenCodeModels } from "./provider-opencode";
import { fetchLocalModels } from "./provider-local";
import { fetchCloudflareModels } from "./provider-cloudflare";
import { PORT, PROXY_URL } from "./proxy-manager";
import {
  ALL_CLIENTS,
  CLIENTS,
  isInstalled,
  checkAll,
  installClient,
  checkNodeVersion,
  type ClientName,
} from "./install-engine";

const program = new Command();

program
  .name("pontis")
  .version(VERSION)
  .description(
    "Translation proxy bridging Anthropic/OpenAI formats to run Claude Code, Codex, Pi, OpenCode, and local models",
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

// Subcommand: claude
addPontisOptions(
  program
    .command("claude")
    .description("Start proxy and launch Claude Code with a configured model")
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
    .description("Start proxy and launch Codex with a configured model")
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
    .description("Start proxy and launch OpenCode with a configured model")
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
    .description("Start proxy and launch Pi coding agent with a configured model")
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

// Subcommand: install — manage client tool installations
program
  .command("install")
  .description("Install or check coding agent CLI tools")
  .argument("[clients...]", "Client(s) to install (claude, codex, opencode, pi, or 'all')")
  .option("--list", "Show installed clients and versions")
  .option("--check", "Exit 0 if all specified clients are installed, 1 if missing")
  .option("--json", "Output in JSON format")
  .action(async (clients: string[], opts: { list?: boolean; check?: boolean; json?: boolean }) => {
    try {
      // --list: show status of all clients
      if (opts.list) {
        const status = checkAll();
        if (opts.json || jsonMode) {
          const result = ALL_CLIENTS.map((name) => ({
            name,
            displayName: CLIENTS[name].name,
            installed: status[name],
            binary: CLIENTS[name].binary,
          }));
          outputJson({ clients: result });
        }
        section("Installed Clients");
        for (const name of ALL_CLIENTS) {
          const def = CLIENTS[name];
          if (status[name]) {
            kv(def.name, t.success("installed"));
          } else {
            const nodeIssue = checkNodeVersion(name);
            kv(def.name, nodeIssue ? t.warning(nodeIssue) : t.muted("not installed"));
          }
        }
        console.log();
        badge("muted", "Manage: pontis install <client>");
        return;
      }

      // --check: exit code only
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
            badge("error", `${CLIENTS[name as ClientName].name} is not installed`);
          }
          process.exit(1);
        }
        if (opts.json || jsonMode) {
          outputJson({ ok: true, clients: names });
        }
        badge("success", "All specified clients are installed");
        return;
      }

      // Install specified clients (or prompt if none specified)
      const names = clients.length > 0
        ? (clients.includes("all") ? ALL_CLIENTS : clients as ClientName[])
        : null;

      if (names) {
        // Non-interactive: install specified clients
        for (const name of names) {
          if (isInstalled(name)) {
            badge("muted", `${CLIENTS[name].name} already installed — skipping`);
            continue;
          }
          await installClient(name, { interactive: false });
        }
        if (opts.json || jsonMode) {
          const status = checkAll();
          outputJson({ clients: names.map((n) => ({ name: n, installed: status[n] })) });
        }
      } else {
        // Interactive: let user choose
        const { select } = await import("./ui");
        const choices = ALL_CLIENTS.map((name) => {
          const def = CLIENTS[name];
          const installed = isInstalled(name);
          const suffix = installed ? t.success(" ✓ installed") : t.muted(" not installed");
          return `${t.primary(def.name)}${suffix}` as string;
        });
        choices.push(`${t.primary("All")}     ${t.muted("Install all missing clients")}` as string);
        choices.push(`${t.muted("Cancel")}` as string);

        const result = await select("Which client(s) would you like to install?", choices);
        if (result.index === ALL_CLIENTS.length) {
          // "All"
          for (const name of ALL_CLIENTS) {
            if (!isInstalled(name)) {
              await installClient(name, { interactive: true });
            }
          }
        } else if (result.index < ALL_CLIENTS.length) {
          const name = ALL_CLIENTS[result.index];
          if (!isInstalled(name)) {
            await installClient(name, { interactive: true });
          } else {
            badge("muted", `${CLIENTS[name].name} is already installed`);
          }
        }
      }
    } catch (e: any) {
      if (jsonMode) outputJsonError("install_failed", e.message || String(e));
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    }
  });

// Subcommand: update-key
program
  .command("update-key")
  .description("Save a new OpenCode API key")
  .argument("[key]", "New API key (prompts if omitted)")
  .action((key) => {
    cmdUpdateKey(key).catch((e) => {
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    });
  });

// Subcommand: models — list available models
program
  .command("models")
  .description("List available models from the configured provider")
  .option("-p, --provider <type>", "Provider: opencode | local | cloudflare")
  .option("-u, --upstream <url>", "Upstream endpoint URL")
  .action(async (opts) => {
    try {
      const provider: "opencode" | "local" | "cloudflare" =
        opts.provider ||
        (process.env.PONTIS_PROVIDER as "opencode" | "local" | "cloudflare") ||
        (process.env.PONTIS_UPSTREAM_URL ? "local" : "opencode");

      let upstreamUrl = opts.upstream || process.env.PONTIS_UPSTREAM_URL;

      if (provider === "cloudflare") {
        const savedCf = getCloudflareConfigSaved();
        const apiToken =
          opts.apiKey || process.env.CLOUDFLARE_API_TOKEN || savedCf.apiToken;
        const accountId =
          process.env.CLOUDFLARE_ACCOUNT_ID || savedCf.accountId;
        if (!apiToken || !accountId) {
          const msg =
            "Cloudflare API Token and Account ID are required. Run interactive setup or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.";
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
          section("Available Models");
          for (const m of models) kv("Model", t.primary(m));
        }
      } else if (provider === "opencode") {
        const apiKey = getOpenCodeApiKey() || "";
        if (!apiKey) {
          if (jsonMode)
            outputJsonError(
              "missing_api_key",
              "No OpenCode API key found. Set OPENCODE_API_KEY or run: pontis update-key",
            );
          badge(
            "error",
            "No OpenCode API key found. Set OPENCODE_API_KEY or run: pontis update-key",
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
                  text: `Found ${models.length} model${models.length === 1 ? "" : "s"}`,
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
          section("Available Models");
          for (const m of models) kv("Model", t.primary(m));
        }
      } else {
        if (!upstreamUrl) {
          if (jsonMode)
            outputJsonError(
              "missing_upstream",
              "Set --upstream or PONTIS_UPSTREAM_URL for local provider",
            );
          badge(
            "error",
            "Set --upstream or PONTIS_UPSTREAM_URL for local provider",
          );
          process.exit(1);
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
          badge("warning", "No models returned from upstream. Is it running?");
        } else {
          section("Available Models");
          for (const m of models) kv("Model", t.primary(m));
        }
      }
    } catch (e: any) {
      if (jsonMode) outputJsonError("fetch_failed", e.message || String(e));
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    }
  });

// Subcommand: status — show proxy and configuration status
program
  .command("status")
  .description("Show current proxy and configuration status")
  .action(async () => {
    try {
      let proxyRunning = false;
      let proxyPort = PORT;

      // Check if proxy is running by hitting the root endpoint
      try {
        const res = await fetch(PROXY_URL + "/", {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) proxyRunning = true;
      } catch {}

      const provider: string =
        process.env.PONTIS_PROVIDER ||
        (process.env.PONTIS_UPSTREAM_URL ? "local" : "opencode");
      const model =
        process.env.PONTIS_MODEL ||
        (provider === "cloudflare"
          ? CLOUDFLARE_FALLBACK_MODELS[0]
          : FALLBACK_MODELS[0]);
      const upstream =
        process.env.PONTIS_UPSTREAM_URL ||
        (provider === "cloudflare"
          ? "(Cloudflare AI Gateway)"
          : "(default OpenCode Zen)");
      const format = process.env.PONTIS_UPSTREAM_FORMAT || "openai";
      const debug = process.env.PONTIS_DEBUG === "true";
      const keyExists =
        provider === "cloudflare"
          ? existsSync(CLOUDFLARE_CONFIG_FILE)
          : getOpenCodeApiKey() !== null;

      // Check client installations
      const clientStatus = checkAll();

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
          clients: ALL_CLIENTS.map((n) => ({
            name: n,
            installed: clientStatus[n],
          })),
        });
      }

      section("Pontis Status");

      if (proxyRunning) {
        badge("success", `Proxy running on ${t.secondary(PROXY_URL)}`);
      } else {
        badge(
          "warning",
          `Proxy not running (start with: ${t.secondary("pontis server")})`,
        );
      }

      console.log();
      section("Configuration");
      kv("Provider", t.primary(provider));
      kv("Model", t.primary(model));
      kv("Upstream", t.muted(upstream));
      kv("Format", format);
      kv("Debug", debug ? t.success("on") : t.muted("off"));
      kv("API Key", keyExists ? t.success("saved") : t.warning("not found"));
      kv("Logs", t.muted(PROXY_LOG));
      console.log();

      section("Installed Clients");
      for (const name of ALL_CLIENTS) {
        const def = CLIENTS[name];
        if (clientStatus[name]) {
          kv(def.name, t.success("installed"));
        } else {
          kv(def.name, t.muted("not installed"));
        }
      }
      console.log();
      badge("muted", "Manage: pontis install <client>");
      console.log();
    } catch (e: any) {
      if (jsonMode) outputJsonError("status_failed", e.message || String(e));
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    }
  });

// Default (no subcommand): interactive wizard
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
