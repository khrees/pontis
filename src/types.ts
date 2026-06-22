/**
 * Type definitions for Anthropic and OpenAI API shapes.
 */

// --- Anthropic Types ---

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicTextBlock[];
  is_error?: boolean;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
  cache_control?: { type: "ephemeral" };
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | string[] | AnthropicSystemBlock[];
  max_tokens?: number;
  metadata?: Record<string, unknown>;
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  tool_choice?: unknown;
  tools?: AnthropicTool[];
  top_p?: number;
  top_k?: number;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage?: AnthropicUsage;
}

// --- OpenAI Types ---

export interface OpenAIImageURL {
  url: string;
  detail?: "auto" | "low" | "high";
}

export interface OpenAIContentPartText {
  type: "text";
  text: string;
}

export interface OpenAIContentPartImage {
  type: "image_url";
  image_url: OpenAIImageURL;
}

export type OpenAIContentPart = OpenAIContentPartText | OpenAIContentPartImage;

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name?: string;
    arguments: string;
  };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  stop?: string | string[];
  tools?: OpenAITool[];
  tool_choice?: unknown;
  prompt_cache_key?: string;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  input_tokens_details?: {
    cached_tokens?: number;
  };
  cache_read_input_tokens?: number;
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

// --- OpenAI Legacy Completion Types (for Codex, etc.) ---

export interface OpenAICompletionRequest {
  model: string;
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop?: string | string[];
}

export interface OpenAICompletionChoice {
  text: string;
  index: number;
  logprobs?: unknown;
  finish_reason: "stop" | "length" | null;
}

export interface OpenAICompletionResponse {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: OpenAICompletionChoice[];
  usage?: OpenAIUsage;
}
