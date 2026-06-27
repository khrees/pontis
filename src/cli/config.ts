import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __CLI_DIR = dirname(fileURLToPath(import.meta.url));
// In dev mode (tsx running src/cli/index.ts), ROOT is the project root (parent of src/).
// In installed/bundled mode, ROOT is the script's own directory.
export const ROOT = existsSync(join(dirname(dirname(__CLI_DIR)), "package.json"))
  ? dirname(dirname(__CLI_DIR))
  : dirname(__CLI_DIR);

export const KEY_FILE = join(homedir(), ".opencode_api_key");
export const CLOUDFLARE_CONFIG_FILE = join(homedir(), ".cloudflare_gateway_config");
export const CACHE_FILE = join(homedir(), ".pontis_models_cache.json");
export const DIST_PROXY = join(ROOT, "dist", "proxy.js");
export const SRC_DIR = join(ROOT, "src");
export const PONTIS_DIR = join(homedir(), ".pontis");
export const PROXY_LOG = join(PONTIS_DIR, "proxy.log");

export const FALLBACK_MODELS = [
  "mimo-v2.5-free",
  "deepseek-v4-flash-free",
  "big-pickle",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
];

export const CLOUDFLARE_FALLBACK_MODELS = [
  "@cf/moonshotai/kimi-k2.6",
  "@cf/zai-org/glm-5.2",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/deepseek-ai/deepseek-r1-distill-llama-8b",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
  "@cf/qwen/qwen2.5-14b-instruct",
  "@cf/qwen/qwen2.5-7b-instruct",
  "@cf/qwen/qwq-32b",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.2-11b-vision-instruct",
];

export const CLOUDFLARE_CATEGORIES = {
  flagship: {
    name: "🚀 Flagship / Coding / Reasoning (Kimi 2.6, GLM 5.2, Qwen 2.5 Coder, DeepSeek R1 32B...)",
    keywords: ["kimi-k2.6", "kimi-k2.7", "glm-5.2", "qwen2.5-coder", "deepseek-r1-distill-qwen-32b", "qwq-32b"],
    fallbacks: [
      "@cf/moonshotai/kimi-k2.6",
      "@cf/zai-org/glm-5.2",
      "@cf/qwen/qwen2.5-coder-32b-instruct",
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
      "@cf/qwen/qwq-32b",
    ]
  },
  cheap: {
    name: "⚡ Fast / Cheap / Lightweight (Llama 3.2, Qwen 2.5 7B/14B, DeepSeek R1 8B, GLM Flash...)",
    keywords: ["llama-3.2-1b", "llama-3.2-3b", "glm-4.7-flash", "llama-3.1-8b", "qwen2.5-7b", "qwen2.5-14b", "deepseek-r1-distill-llama-8b"],
    fallbacks: [
      "@cf/meta/llama-3.2-3b-instruct",
      "@cf/meta/llama-3.2-1b-instruct",
      "@cf/qwen/qwen2.5-7b-instruct",
      "@cf/qwen/qwen2.5-14b-instruct",
      "@cf/deepseek-ai/deepseek-r1-distill-llama-8b",
      "@cf/zai-org/glm-4.7-flash",
      "@cf/meta/llama-3.1-8b-instruct",
    ]
  },
  vision: {
    name: "👁️ Vision Models (Llama 3.2 Vision...)",
    keywords: ["vision", "llava"],
    fallbacks: [
      "@cf/meta/llama-3.2-11b-vision-instruct",
    ]
  }
};

export interface PontisEnv {
  clientCmd?: string;
  model?: string;
  provider?: "opencode" | "local" | "cloudflare";
  apiKey?: string;
  upstreamUrl?: string;
  upstreamFormat?: string;
}

export function getCloudflareConfigSaved(): { apiToken?: string; accountId?: string; gatewayId?: string } {
  if (existsSync(CLOUDFLARE_CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(CLOUDFLARE_CONFIG_FILE, "utf-8"));
    } catch {}
  }
  return {};
}

export function getLocalApiKey(): string {
  return (
    process.env.LOCAL_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "local-model-dummy-api-key-value-32-chars-long"
  );
}
