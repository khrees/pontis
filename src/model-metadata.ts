/**
 * Model-specific metadata for Codex CLI compatibility.
 */

export interface ModelMetadata {
  context_window: number;
  max_output_tokens: number;
  supports_reasoning: boolean;
  supports_parallel_tool_calls: boolean;
  supports_structured_tool_calls: boolean;
  experimental_supported_tools: string[];
}

const CODEX_CORE_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
];

const DEFAULT_METADATA: ModelMetadata = {
  context_window: 128000,
  max_output_tokens: 16384,
  supports_reasoning: false,
  supports_parallel_tool_calls: true,
  supports_structured_tool_calls: true,
  experimental_supported_tools: CODEX_CORE_TOOLS,
};

/** Per-model overrides. Only fields that differ from defaults need to be set. */
export const KNOWN_MODEL_METADATA: Record<string, Partial<ModelMetadata>> = {
  "mimo-v2.5-free": {
    context_window: 131072,
    supports_reasoning: true,
  },
  "deepseek-v4-flash-free": {
    context_window: 131072,
    supports_reasoning: true,
  },
  "big-pickle": {
    context_window: 131072,
  },
  "nemotron-3-ultra-free": {
    context_window: 131072,
  },
  "north-mini-code-free": {
    context_window: 65536,
    max_output_tokens: 8192,
  },
  "qwen3.6-plus": {
    context_window: 131072,
    max_output_tokens: 8192,
  },
  "@cf/meta/llama-3-8b-instruct": {
    context_window: 8192,
    max_output_tokens: 2048,
  },
  "@cf/meta/llama-3.1-8b-instruct": {
    context_window: 131072,
    max_output_tokens: 8192,
  },
  "@cf/meta/llama-3.2-1b-instruct": {
    context_window: 131072,
    max_output_tokens: 4096,
  },
  "@cf/meta/llama-3.2-3b-instruct": {
    context_window: 131072,
    max_output_tokens: 4096,
  },
  "@cf/meta/llama-3.2-11b-vision-instruct": {
    context_window: 131072,
    max_output_tokens: 8192,
  },
  "@cf/qwen/qwen1.5-14b-chat-awq": {
    context_window: 32768,
    max_output_tokens: 4096,
  },
  "@cf/qwen/qwen2.5-coder-32b-instruct": {
    context_window: 32768,
    max_output_tokens: 8192,
  },
  "@cf/qwen/qwq-32b": {
    context_window: 32768,
    max_output_tokens: 8192,
    supports_reasoning: true,
  },
  "@cf/moonshotai/kimi-k2.6": {
    context_window: 262144,
    max_output_tokens: 8192,
    supports_reasoning: true,
  },
  "@cf/moonshotai/kimi-k2.7": {
    context_window: 262144,
    max_output_tokens: 8192,
    supports_reasoning: true,
  },
  "@cf/moonshotai/kimi-k2.7-code": {
    context_window: 262144,
    max_output_tokens: 8192,
    supports_reasoning: true,
  },
  "@cf/zai-org/glm-4.7-flash": {
    context_window: 131072,
    max_output_tokens: 8192,
  },
  "@cf/zai-org/glm-5.2": {
    context_window: 262144,
    max_output_tokens: 8192,
    supports_reasoning: true,
  },
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": {
    context_window: 131072,
    max_output_tokens: 8192,
    supports_reasoning: true,
  },
  "@cf/deepseek-ai/deepseek-r1-distill-llama-8b": {
    context_window: 131072,
    max_output_tokens: 8192,
    supports_reasoning: true,
  },
  "@cf/qwen/qwen2.5-7b-instruct": {
    context_window: 131072,
    max_output_tokens: 8192,
  },
  "@cf/qwen/qwen2.5-14b-instruct": {
    context_window: 131072,
    max_output_tokens: 8192,
  },
};

export function getModelMetadata(modelId: string): ModelMetadata {
  const exact = KNOWN_MODEL_METADATA[modelId];
  if (exact) return { ...DEFAULT_METADATA, ...exact };

  let bestKey: string | undefined;
  for (const key of Object.keys(KNOWN_MODEL_METADATA)) {
    if (modelId.startsWith(key) && (!bestKey || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  if (bestKey) {
    return { ...DEFAULT_METADATA, ...KNOWN_MODEL_METADATA[bestKey] };
  }

  return { ...DEFAULT_METADATA };
}

export function buildCodexModelEntry(modelId: string) {
  const meta = getModelMetadata(modelId);

  return {
    slug: modelId,
    display_name: modelId,
    description: `${modelId} model via Pontis`,
    supported_in_api: true,
    visibility: "list",
    default_reasoning_level: meta.supports_reasoning ? "medium" : "none",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth" },
      { effort: "high", description: "Greater reasoning depth" },
    ],
    shell_type: "shell_command",
    priority: 1,
    base_instructions: "",
    supports_reasoning_summaries: meta.supports_reasoning,
    support_verbosity: false,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: {
      mode: "tokens",
      limit: meta.context_window,
    },
    supports_parallel_tool_calls: meta.supports_parallel_tool_calls,
    supports_structured_tool_calls: meta.supports_structured_tool_calls,
    experimental_supported_tools: meta.experimental_supported_tools,
    context_window: meta.context_window,
    max_context_window: meta.context_window,
    max_output_tokens: meta.max_output_tokens,
  };
}
