import {
  section,
  badge,
  kv,
  select,
  input,
  createSpinner,
  t,
} from "./ui";
import {
  CLIENTS,
  type ClientName,
  checkAll,
} from "./install-engine";
import { ensureClientReady } from "./client-launcher";
import {
  getPreferences,
  savePreferences,
  type ProviderType,
} from "./preferences";
import {
  getOpenCodeApiKey,
  getGoogleAuthToken,
  getCloudflareConfigSaved,
  getCloudflareUpstreamUrl,
  getLocalApiKey,
  GOOGLE_DEFAULT_UPSTREAM,
  getProviderDisplayName,
  normalizeProvider,
} from "./config";
import { storeGoogleApiKey, storeOpenCodeApiKey, storeCloudflareApiToken } from "../secure-storage";
import { writeFileSync } from "node:fs";
import { CLOUDFLARE_CONFIG_FILE } from "./config";
import { redactKey } from "../redact";
import {
  fetchOpenCodeModelsGrouped,
} from "./provider-opencode";
import {
  fetchCloudflareModels,
  categorizeCloudflareModels,
  KNOWN_CLOUDFLARE_MODELS,
  DEFAULT_CLOUDFLARE_MODEL,
} from "./provider-cloudflare";
import {
  fetchLocalModels,
  fetchOllamaRegistryModels,
  categorizeLocalModels,
  KNOWN_OLLAMA_MODELS,
  DEFAULT_LOCAL_MODEL,
  LOCAL_ENGINES,
  detectRunningLocalEngine,
} from "./provider-local";
import {
  fetchGoogleModels,
  GOOGLE_DEFAULT_MODELS,
} from "./provider-google";
import type {
  WizardStepDefinition,
  WizardContext,
  StepAction,
} from "./wizard-machine";

export interface ProviderCategoryMap {
  free: string[];
  frontier: string[];
  chinese: string[];
  others: string[];
}

export function createWizardSteps(): WizardStepDefinition[] {
  return [
    // 1. Resume Last Session (Conditional)
    {
      id: "resume",
      title: "Resume Session",
      canSkip: (ctx) => {
        return (
          Boolean(ctx.env.provider) ||
          Boolean(ctx.env.model) ||
          Boolean(ctx.env.clientCmd) ||
          !ctx.lastUsed?.client ||
          !ctx.lastUsed?.provider ||
          !ctx.lastUsed?.model
        );
      },
      run: async (ctx): Promise<StepAction> => {
        const last = ctx.lastUsed!;
        const clientName = CLIENTS[last.client as ClientName]?.name || last.client;
        const res = await select(
          "Launch Session",
          [
            `Launch last session — ${clientName} · ${last.model} · ${getProviderDisplayName(last.provider)}`,
            `Set up / change provider, model, or client`,
          ],
          { allowCustom: false, allowBack: false, defaultIndex: 0 },
        );

        if (res.index === 0) {
          return {
            type: "next",
            patch: {
              launchDirectly: true,
              client: last.client as ClientName,
              provider: last.provider,
              model: last.model,
            },
          };
        }

        return { type: "next" };
      },
    },

    // 2. Provider Selection
    {
      id: "provider",
      title: "Select Provider",
      canSkip: (ctx) => Boolean(ctx.env.provider && normalizeProvider(ctx.env.provider)),
      run: async (ctx): Promise<StepAction> => {
        const detectedLocal = await detectRunningLocalEngine();
        const localDesc = detectedLocal
          ? `Local AI (${detectedLocal.name} running on ${detectedLocal.url})`
          : "Local AI (Ollama, LM Studio, Llama.cpp)";

        const providers: ProviderType[] = ["google", "opencode", "local", "cloudflare"];
        const items = [
          `${t.primary("Google (Gemini)".padEnd(18))} ${t.muted("Free Gemini & Gemma models (AI Studio key)")}`,
          `${t.primary("OpenCode".padEnd(18))} ${t.muted("Free cloud models (Zen/Go) — Zero setup")}`,
          `${t.primary("Local".padEnd(18))} ${t.muted(localDesc)}`,
          `${t.primary("Cloudflare".padEnd(18))} ${t.muted("Workers AI via AI Gateway")}`,
        ];

        let defaultIdx = 1;
        const active = ctx.provider || ctx.lastUsed?.provider;
        if (active) {
          const idx = providers.indexOf(active);
          if (idx >= 0) defaultIdx = idx;
        }

        const res = await select("Choose your AI provider", items, {
          allowCustom: false,
          allowBack: true,
          defaultIndex: defaultIdx,
        });

        if (res.isBack) {
          return { type: "back" };
        }

        const selected = providers[res.index] || "opencode";
        const patch: Partial<WizardContext> = { provider: selected };

        // If provider changed, reset model and category
        if (selected !== ctx.provider) {
          patch.category = undefined;
          patch.model = undefined;
          patch.availableModels = undefined;
          patch.apiKey = undefined;
          patch.upstreamUrl = undefined;
        }

        return { type: "next", patch };
      },
    },

    // 3. Credentials & Connection Setup
    {
      id: "credentials",
      title: "Authentication",
      run: async (ctx): Promise<StepAction> => {
        const provider = ctx.provider || "opencode";

        switch (provider) {
          case "google": {
            const existing =
              process.env.GOOGLE_API_KEY ||
              process.env.GEMINI_API_KEY ||
              getGoogleAuthToken() ||
              ctx.apiKey;

            if (existing) {
              const options = [
                `Use saved API key (${t.success(redactKey(existing))})`,
                "Enter a new / different Google AI Studio key",
              ];
              const res = await select("Google Authentication", options, {
                allowCustom: false,
                allowBack: true,
                backLabel: "← Back to Provider",
                defaultIndex: 0,
              });

              if (res.isBack) return { type: "back" };
              if (res.index === 0) {
                return {
                  type: "next",
                  patch: { apiKey: existing, upstreamUrl: GOOGLE_DEFAULT_UPSTREAM },
                };
              }
            }

            console.log(
              `  1. Open ${t.secondary("https://aistudio.google.com/apikey")} in your browser`,
            );
            console.log(
              `  2. Click ${t.bold('"Create API key"')} (100% Free with standard Google account)`,
            );
            console.log(`  3. Paste the key below:`);

            const key = await input("Google AI Studio API Key", undefined, true, true);
            if (key === "__BACK__") return { type: "back" };
            if (!key.trim()) {
              badge("error", "Google AI Studio API key is required.");
              return { type: "back" };
            }

            const cleanKey = key.trim();
            storeGoogleApiKey(cleanKey);
            badge("success", "Google API key saved securely");
            return {
              type: "next",
              patch: { apiKey: cleanKey, upstreamUrl: GOOGLE_DEFAULT_UPSTREAM },
            };
          }

          case "opencode": {
            const existing =
              process.env.OPENCODE_API_KEY || getOpenCodeApiKey() || ctx.apiKey;

            if (existing) {
              const options = [
                `Use saved API key (${t.success(redactKey(existing))})`,
                "Enter a new / different OpenCode API key",
                "Use free tier (clear API key, 100% free Zen/Go models)",
              ];
              const res = await select("OpenCode Authentication", options, {
                allowCustom: false,
                allowBack: true,
                backLabel: "← Back to Provider",
                defaultIndex: 0,
              });

              if (res.isBack) return { type: "back" };
              if (res.index === 0) {
                return { type: "next", patch: { apiKey: existing } };
              }
              if (res.index === 2) {
                storeOpenCodeApiKey("");
                badge("info", "Switched to OpenCode free tier");
                return { type: "next", patch: { apiKey: undefined } };
              }
            } else {
              const options = [
                "Use free tier (Zen/Go models, zero setup & zero API key)",
                "Enter an OpenCode API key (from https://opencode.ai/console)",
              ];
              const res = await select("OpenCode Authentication", options, {
                allowCustom: false,
                allowBack: true,
                backLabel: "← Back to Provider (Switch to Google Gemini for 100% free access)",
                defaultIndex: 0,
              });

              if (res.isBack) return { type: "back" };
              if (res.index === 0) {
                return { type: "next", patch: { apiKey: undefined } };
              }
            }

            console.log(
              `  OpenCode offers 100% free models (Zen/Go) without an API key.`,
            );
            console.log(
              `  If you have an OpenCode key from ${t.secondary("https://opencode.ai/console")}, enter it below:`,
            );

            const key = await input(
              "OpenCode API Key",
              undefined,
              true,
              true,
            );
            if (key === "__BACK__") return { type: "back" };

            const cleanKey = key.trim() || undefined;
            if (cleanKey) {
              storeOpenCodeApiKey(cleanKey);
              badge("success", "OpenCode API key saved securely");
            }

            return { type: "next", patch: { apiKey: cleanKey } };
          }

          case "cloudflare": {
            const saved = getCloudflareConfigSaved();
            const existingToken = ctx.apiKey || saved.apiToken;
            const existingAccount = ctx.accountId || saved.accountId;

            if (existingToken && existingAccount) {
              const options = [
                `Use saved configuration (Account: ${existingAccount}, Token: ${t.success(redactKey(existingToken))})`,
                "Update Cloudflare configuration (Account ID, Gateway, Token)",
              ];
              const res = await select("Cloudflare Authentication", options, {
                allowCustom: false,
                allowBack: true,
                backLabel: "← Back to Provider",
                defaultIndex: 0,
              });

              if (res.isBack) return { type: "back" };
              if (res.index === 0) {
                const upstreamUrl = getCloudflareUpstreamUrl(
                  existingAccount,
                  ctx.gatewayId || saved.gatewayId || "",
                );
                return {
                  type: "next",
                  patch: {
                    accountId: existingAccount,
                    gatewayId: ctx.gatewayId || saved.gatewayId || "",
                    apiKey: existingToken,
                    upstreamUrl,
                  },
                };
              }
            }

            console.log(`  Configure Cloudflare Workers AI / AI Gateway`);

            const accountId = await input(
              "Cloudflare Account ID",
              ctx.accountId || saved.accountId,
              false,
              true,
            );
            if (accountId === "__BACK__") return { type: "back" };
            if (!accountId.trim()) {
              badge("error", "Account ID is required.");
              return { type: "back" };
            }

            const gatewayId = await input(
              "Cloudflare AI Gateway ID (optional, Enter for direct Workers AI)",
              ctx.gatewayId || saved.gatewayId || "",
              false,
              true,
            );
            if (gatewayId === "__BACK__") return { type: "back" };

            const apiToken = await input(
              "Cloudflare API Token",
              ctx.apiKey || saved.apiToken,
              true,
              true,
            );
            if (apiToken === "__BACK__") return { type: "back" };
            if (!apiToken.trim()) {
              badge("error", "API Token is required.");
              return { type: "back" };
            }

            const cleanAccount = accountId.trim();
            const cleanGateway = gatewayId ? gatewayId.trim() : "";
            const cleanToken = apiToken.trim();

            writeFileSync(
              CLOUDFLARE_CONFIG_FILE,
              JSON.stringify({ accountId: cleanAccount, gatewayId: cleanGateway }, null, 2),
              { encoding: "utf-8", mode: 0o600 },
            );
            storeCloudflareApiToken(cleanToken);
            badge("success", "Cloudflare configuration saved securely");

            const upstreamUrl = getCloudflareUpstreamUrl(cleanAccount, cleanGateway);
            return {
              type: "next",
              patch: {
                accountId: cleanAccount,
                gatewayId: cleanGateway,
                apiKey: cleanToken,
                upstreamUrl,
              },
            };
          }

          case "local": {
            const prefs = getPreferences();
            const detected = await detectRunningLocalEngine();

            const options = LOCAL_ENGINES.map((e) => {
              const isDetected = detected && detected.name === e.name;
              const detectedTag = isDetected ? ` ${t.success("(Running)")}` : "";
              return `${t.primary(e.name.padEnd(12))}  ${t.muted(e.url)}${detectedTag}`;
            });

            const defaultIdx = detected
              ? LOCAL_ENGINES.findIndex((e) => e.name === detected.name)
              : prefs.localEndpoint
                ? LOCAL_ENGINES.findIndex((e) => e.url === prefs.localEndpoint)
                : 0;

            const res = await select("Choose local model engine", options, {
              allowCustom: true,
              allowBack: true,
              backLabel: "← Back to Provider",
              defaultIndex: defaultIdx >= 0 ? defaultIdx : 0,
              customLabel: "Custom URL (enter endpoint manually)",
            });

            if (res.isBack) return { type: "back" };

            let upstreamUrl: string;
            if (res.index === -1) {
              const custom = await input(
                "Enter custom endpoint URL",
                prefs.localEndpoint || "http://localhost:11434/v1",
                false,
                true,
              );
              if (custom === "__BACK__") return { type: "back" };
              upstreamUrl = custom.trim() || LOCAL_ENGINES[0].url;
            } else {
              upstreamUrl = LOCAL_ENGINES[res.index].url;
            }

            savePreferences({ localEndpoint: upstreamUrl });
            return {
              type: "next",
              patch: {
                upstreamUrl,
                upstreamFormat: "openai",
                apiKey: getLocalApiKey(),
              },
            };
          }
        }
      },
    },

    // 4. Model Category Selection (Uniform 4 Categories)
    {
      id: "category",
      title: "Model Category",
      canSkip: (ctx) => Boolean(ctx.env.model),
      run: async (ctx): Promise<StepAction> => {
        const provider = ctx.provider || "opencode";
        const spin = createSpinner(`Loading models for ${getProviderDisplayName(provider)}...`);

        let groups: ProviderCategoryMap;

        if (provider === "opencode") {
          const ocGroups = await fetchOpenCodeModelsGrouped(ctx.apiKey || "");
          groups = {
            free: ocGroups.free,
            frontier: ocGroups.frontier,
            chinese: ocGroups.chinese,
            others: ocGroups.others,
          };
        } else if (provider === "cloudflare") {
          const raw = await fetchCloudflareModels(ctx.accountId || "", ctx.apiKey || "");
          const list = raw.length > 0 ? raw : [...KNOWN_CLOUDFLARE_MODELS];
          const cfGroups = categorizeCloudflareModels(list);
          groups = {
            free: cfGroups.free,
            frontier: cfGroups.frontier,
            chinese: cfGroups.chinese,
            others: cfGroups.others,
          };
        } else if (provider === "local") {
          const raw = await fetchLocalModels(ctx.upstreamUrl || "http://localhost:11434/v1", ctx.apiKey || "");
          const models = raw.length > 0 ? raw : await fetchOllamaRegistryModels();
          const list = models.length > 0 ? models : [...KNOWN_OLLAMA_MODELS];
          const locGroups = categorizeLocalModels(list);
          groups = {
            free: locGroups.free,
            frontier: locGroups.frontier,
            chinese: locGroups.chinese,
            others: locGroups.others,
          };
        } else {
          // Google
          const raw = await fetchGoogleModels(ctx.apiKey || "");
          const list = raw.length > 0 ? raw : GOOGLE_DEFAULT_MODELS;
          groups = {
            free: list.filter((m) => m.includes("flash") || m.includes("gemma")),
            frontier: list.filter((m) => m.includes("pro") || m.includes("thinking")),
            chinese: [],
            others: list,
          };
          if (groups.free.length === 0) groups.free = [...list];
          if (groups.frontier.length === 0) groups.frontier = [...list];
        }

        spin.stop({ type: "success", text: "Models ready" });

        const catDefs: {
          id: "free" | "frontier" | "chinese" | "others";
          name: string;
          hint: string;
          models: string[];
        }[] = [
          { id: "free", name: "Free", hint: "Zero token cost / included tier", models: groups.free },
          { id: "frontier", name: "Frontier", hint: "Flagship reasoning & high-parameter", models: groups.frontier },
          { id: "chinese", name: "Chinese", hint: "Qwen, DeepSeek, Kimi, MiniMax, GLM", models: groups.chinese },
          { id: "others", name: "Others", hint: "Meta, Google, Mistral, Microsoft", models: groups.others },
        ];
        const validCatDefs = catDefs.filter((c) => c.models.length > 0);

        const options = validCatDefs.map(
          (c) =>
            `${t.primary(c.name.padEnd(12))} ${t.muted(`${c.models.length} model${c.models.length === 1 ? "" : "s"}`)} · ${t.dim(c.hint)}`,
        );

        let defaultIdx = 0;
        if (ctx.category) {
          const found = validCatDefs.findIndex((c) => c.id === ctx.category);
          if (found >= 0) defaultIdx = found;
        }

        const res = await select("Pick model category", options, {
          allowCustom: false,
          allowBack: true,
          backLabel: "← Back to Authentication",
          defaultIndex: defaultIdx,
        });

        if (res.isBack) {
          return { type: "back" };
        }

        const chosen = validCatDefs[res.index];
        return {
          type: "next",
          patch: {
            category: chosen.id,
            availableModels: chosen.models,
          },
        };
      },
    },

    // 5. Model Selection
    {
      id: "model",
      title: "Model Selection",
      canSkip: (ctx) => Boolean(ctx.env.model),
      run: async (ctx): Promise<StepAction> => {
        const models = ctx.availableModels || [];
        const fallbackDefault =
          ctx.provider === "cloudflare"
            ? DEFAULT_CLOUDFLARE_MODEL
            : ctx.provider === "local"
              ? DEFAULT_LOCAL_MODEL
              : ctx.provider === "google"
                ? "gemini-2.5-flash"
                : "mimo-v2.5-free";

        if (models.length === 0) {
          const manual = await input("Enter Model ID", ctx.model || fallbackDefault, false, true);
          if (manual === "__BACK__") return { type: "back" };
          return { type: "next", patch: { model: manual.trim() || fallbackDefault } };
        }

        let defaultIdx = 0;
        if (ctx.model) {
          const found = models.indexOf(ctx.model);
          if (found >= 0) defaultIdx = found;
        }

        const res = await select(`Pick a ${ctx.category || ""} model`, models, {
          allowCustom: true,
          allowBack: true,
          backLabel: "← Back to Category Selection",
          defaultIndex: defaultIdx,
          customLabel: "Custom model ID (enter manually)",
        });

        if (res.isBack) return { type: "back" };

        let selectedModel: string;
        if (res.index === -1) {
          const custom = await input("Enter custom model ID", models[0], false, true);
          if (custom === "__BACK__") return { type: "back" };
          selectedModel = custom.trim() || models[0];
        } else {
          selectedModel = models[res.index];
        }

        return { type: "next", patch: { model: selectedModel } };
      },
    },

    // 6. Client Selection
    {
      id: "client",
      title: "Coding Agent Client",
      canSkip: (ctx) => Boolean(ctx.env.clientCmd),
      run: async (ctx): Promise<StepAction> => {
        const clientStatus = checkAll();
        const prefs = getPreferences();
        const clients: { id: ClientName | "server"; name: string; desc: string }[] = [
          { id: "claude", name: "Claude Code", desc: "Anthropic's terminal coding assistant" },
          { id: "codex", name: "Codex", desc: "OpenAI's terminal coding agent" },
          { id: "hermes", name: "Hermes Agent", desc: "Autonomous AI agent by Nous Research" },
          { id: "opencode", name: "OpenCode", desc: "Open-source coding agent (opencode.ai)" },
          { id: "pi", name: "Pi", desc: "The Pi coding agent (pi.dev)" },
          { id: "server", name: "Server", desc: "Run proxy server only (no client launcher)" },
        ];

        let defaultIdx = 0;
        const defaultChoice = ctx.client || prefs.defaultClient || ctx.lastUsed?.client || "claude";

        const options = clients.map((c, i) => {
          if (c.id === defaultChoice) defaultIdx = i;
          const isInst =
            clientStatus && c.id !== "server"
              ? clientStatus[c.id as ClientName]
              : false;
          const rawStatus =
            clientStatus && c.id !== "server"
              ? isInst
                ? "[installed]"
                : "[auto-install]"
              : "";
          const statusCol = rawStatus
            ? isInst
              ? t.success(rawStatus.padEnd(15))
              : t.muted(rawStatus.padEnd(15))
            : "".padEnd(15);
          return `${t.primary(c.name.padEnd(14))} ${statusCol} ${t.muted(c.desc)}`;
        });

        const res = await select("Launch which client?", options, {
          allowCustom: false,
          allowBack: true,
          backLabel: "← Back to Model Selection",
          defaultIndex: defaultIdx,
        });

        if (res.isBack) return { type: "back" };

        const chosenClient = clients[res.index]?.id || "claude";
        if (chosenClient !== "server") {
          const ready = await ensureClientReady(chosenClient, true);
          if (!ready) {
            badge("error", `${CLIENTS[chosenClient]?.name || chosenClient} is required to continue.`);
            return { type: "back" };
          }
        }

        return { type: "next", patch: { client: chosenClient } };
      },
    },

    // 7. Launch Pre-flight Review
    {
      id: "review",
      title: "Launch Review",
      run: async (ctx): Promise<StepAction> => {
        section("Launch Configuration Review");
        kv("Provider", t.primary(getProviderDisplayName(ctx.provider)));
        kv("Credentials", ctx.apiKey ? t.success(redactKey(ctx.apiKey)) : t.muted("(Included / Zero setup)"));
        if (ctx.category) kv("Category", t.accent(ctx.category));
        kv("Model", t.primary(ctx.model || "(default)"));
        kv("Client", t.secondary(ctx.client ? (CLIENTS[ctx.client as ClientName]?.name || ctx.client) : "Claude Code"));
        if (ctx.upstreamUrl) kv("Upstream", t.muted(ctx.upstreamUrl));

        const actions = [
          `🚀 ${t.bold("Launch Now")} (Start proxy & launch ${ctx.client || "client"})`,
          `✏️  Change Model or Category`,
          `🔄  Change AI Provider`,
          `💻  Change Coding Agent Client`,
        ];

        const res = await select("Confirm launch configuration", actions, {
          allowCustom: false,
          allowBack: true,
          backLabel: "← Back to Client Selection",
          defaultIndex: 0,
        });

        if (res.isBack) {
          return { type: "back" };
        }

        switch (res.index) {
          case 0:
            return { type: "next" };
          case 1:
            return { type: "jump", stepId: "category" };
          case 2:
            return { type: "jump", stepId: "provider" };
          case 3:
            return { type: "jump", stepId: "client" };
          default:
            return { type: "next" };
        }
      },
    },
  ];
}
