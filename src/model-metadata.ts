/**
 * Model-specific metadata for Codex CLI compatibility.
 *
 * The Codex CLI uses model metadata (context_window, max_output_tokens, etc.)
 * to manage its agent loop. Without accurate values the agent falls back to
 * generic defaults that can cause aggressive context truncation and looping.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelMetadata {
  context_window: number;
  max_output_tokens: number;
  supports_reasoning: boolean;
  supports_parallel_tool_calls: boolean;
  supports_structured_tool_calls: boolean;
  experimental_supported_tools: string[];
}

// ---------------------------------------------------------------------------
// Default Codex tools every model can use via structured tool calls
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Known model metadata
// ---------------------------------------------------------------------------

const DEFAULT_METADATA: ModelMetadata = {
  context_window: 128000,
  max_output_tokens: 16384,
  supports_reasoning: false,
  supports_parallel_tool_calls: true,
  supports_structured_tool_calls: true,
  experimental_supported_tools: CODEX_CORE_TOOLS,
};

/**
 * Per-model overrides. Keys are model IDs as returned by the upstream
 * `/v1/models` endpoint. Partial – any missing field falls back to
 * `DEFAULT_METADATA`.
 */
export const KNOWN_MODEL_METADATA: Record<string, Partial<ModelMetadata>> = {
  // Mimo (Xiaomi) – coding-focused model
  "mimo-v2.5-free": {
    context_window: 131072,
    max_output_tokens: 16384,
    supports_reasoning: true,
    supports_parallel_tool_calls: true,
    supports_structured_tool_calls: true,
  },
  // DeepSeek V4 Flash
  "deepseek-v4-flash-free": {
    context_window: 131072,
    max_output_tokens: 16384,
    supports_reasoning: true,
    supports_parallel_tool_calls: true,
    supports_structured_tool_calls: true,
  },
  // Big Pickle (alias/experimental model)
  "big-pickle": {
    context_window: 131072,
    max_output_tokens: 16384,
    supports_reasoning: false,
    supports_parallel_tool_calls: true,
    supports_structured_tool_calls: true,
  },
  // Nemotron 3 Ultra (NVIDIA)
  "nemotron-3-ultra-free": {
    context_window: 131072,
    max_output_tokens: 16384,
    supports_reasoning: false,
    supports_parallel_tool_calls: true,
    supports_structured_tool_calls: true,
  },
  // North Mini Code
  "north-mini-code-free": {
    context_window: 65536,
    max_output_tokens: 8192,
    supports_reasoning: false,
    supports_parallel_tool_calls: true,
    supports_structured_tool_calls: true,
  },
  // Qwen (vision model)
  "qwen3.6-plus": {
    context_window: 131072,
    max_output_tokens: 8192,
    supports_reasoning: false,
    supports_parallel_tool_calls: true,
    supports_structured_tool_calls: true,
  },
};

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Resolve the best metadata for `modelId`.
 *
 * Resolution order:
 *  1. Exact match in KNOWN_MODEL_METADATA
 *  2. Prefix match (longest prefix wins) – e.g. "mimo-v2.5-free:latest"
 *     would match "mimo-v2.5-free"
 *  3. Sensible defaults
 */
export function getModelMetadata(modelId: string): ModelMetadata {
  // 1. Exact match
  const exact = KNOWN_MODEL_METADATA[modelId];
  if (exact) {
    return { ...DEFAULT_METADATA, ...exact };
  }

  // 2. Prefix match – pick the longest matching key
  let bestKey: string | undefined;
  for (const key of Object.keys(KNOWN_MODEL_METADATA)) {
    if (
      modelId.startsWith(key) &&
      (!bestKey || key.length > bestKey.length)
    ) {
      bestKey = key;
    }
  }
  if (bestKey) {
    return { ...DEFAULT_METADATA, ...KNOWN_MODEL_METADATA[bestKey] };
  }

  // 3. Defaults
  return { ...DEFAULT_METADATA };
}

// ---------------------------------------------------------------------------
// Codex-format builder
// ---------------------------------------------------------------------------

/**
 * Build a complete Codex-format model metadata object for the given model ID.
 */
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
