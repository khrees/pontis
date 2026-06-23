import type {
  AnthropicResponse,
  OpenAIChoice,
  OpenAIMessage,
  OpenAIResponse,
  OpenAIUsage,
  CodexModelEntry,
  ResponsesApiResponse,
  ResponsesApiUsage,
  ResponsesFunctionCallOutputItem,
  ResponsesMessageOutputItem,
  ResponsesOutputItem,
} from "../src/types";

export function emptyResponsesUsage(
  overrides: Partial<ResponsesApiUsage> = {},
): ResponsesApiUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...overrides,
  };
}

export function isMessageOutput(
  item: ResponsesOutputItem,
): item is ResponsesMessageOutputItem {
  return item.type === "message";
}

export function isFunctionCallOutput(
  item: ResponsesOutputItem,
): item is ResponsesFunctionCallOutputItem {
  return item.type === "function_call";
}

export function openAIResponse(
  partial: {
    choices: Array<Partial<OpenAIChoice> & Pick<OpenAIChoice, "message" | "finish_reason">>;
    usage?: Partial<OpenAIUsage>;
  } & Partial<Omit<OpenAIResponse, "choices" | "usage">>,
): OpenAIResponse {
  return {
    id: "test",
    object: "chat.completion",
    created: 0,
    model: "test",
    ...partial,
    choices: partial.choices.map((choice, index) => ({
      index,
      ...choice,
    })) as OpenAIChoice[],
    usage: partial.usage as OpenAIUsage | undefined,
  };
}

export function anthropicResponse(
  partial: Pick<AnthropicResponse, "content"> & Partial<AnthropicResponse>,
): AnthropicResponse {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test",
    stop_reason: "end_turn",
    stop_sequence: null,
    ...partial,
  };
}

export interface CapturedRequestBody {
  model?: string;
  messages: OpenAIMessage[];
  tools?: Array<{
    type: string;
    function: { name: string; description?: string; parameters?: unknown };
  }>;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  temperature?: number;
}

/** @deprecated Use CapturedRequestBody */
export type CapturedChatRequest = CapturedRequestBody;

export function parseCapturedBody(body: BodyInit | null | undefined): CapturedRequestBody {
  return JSON.parse(body as string) as CapturedRequestBody;
}

export function findCodexModel(
  models: CodexModelEntry[],
  slug: string,
): CodexModelEntry | undefined {
  return models.find((m) => m.slug === slug);
}

export interface ResponseCompletedSseEvent {
  type: string;
  response: {
    output: ResponsesOutputItem[];
    usage?: ResponsesApiUsage;
  };
}

export async function parseResponsesJson(response: Response): Promise<ResponsesApiResponse> {
  return response.json() as Promise<ResponsesApiResponse>;
}

export function asResponseCompletedEvent(
  event: unknown,
): ResponseCompletedSseEvent {
  return event as ResponseCompletedSseEvent;
}
