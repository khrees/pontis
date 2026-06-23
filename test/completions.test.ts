import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index';
import {
  formatAnthropicToOpenAICompletion,
  formatOpenAICompletionToAnthropic,
  formatAnthropicToOpenAICompletionResponse as toOpenAICompletionResponse,
  formatOpenAICompletionToAnthropicResponse as toAnthropicResponseFromCompletion
} from '../src/translate/completions';
import { AnthropicRequest, OpenAICompletionRequest, OpenAICompletionResponse, AnthropicResponse } from '../src/types';

const key = 'a'.repeat(32);

describe('completions format translators', () => {
  it('translates Anthropic messages to OpenAI Completion prompt', () => {
    const anthRequest: AnthropicRequest = {
      model: 'code-davinci-002',
      system: 'You are a coder.',
      messages: [
        { role: 'user', content: 'Write a loop' },
        { role: 'assistant', content: '```js\nwhile(true) {}\n```' },
        { role: 'user', content: 'Optimize it' }
      ]
    };

    const result = formatAnthropicToOpenAICompletion(anthRequest);
    expect(result.model).toBe('code-davinci-002');
    expect(result.prompt).toContain('System: You are a coder.');
    expect(result.prompt).toContain('User: Write a loop');
    expect(result.prompt).toContain('Assistant: ```js\nwhile(true) {}\n```');
    expect(result.prompt).toContain('User: Optimize it');
    expect(result.prompt.endsWith('Assistant:')).toBe(true);
  });

  it('translates OpenAI Completion request to Anthropic message format', () => {
    const completionRequest: OpenAICompletionRequest = {
      model: 'claude-3-5-sonnet',
      prompt: 'Write a quicksort in python',
      max_tokens: 1000,
      temperature: 0.5,
      stream: true,
      stop: ['#', 'EOF']
    };

    const result = formatOpenAICompletionToAnthropic(completionRequest);
    expect(result.model).toBe('claude-3-5-sonnet');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Write a quicksort in python' });
    expect(result.max_tokens).toBe(1000);
    expect(result.temperature).toBe(0.5);
    expect(result.stream).toBe(true);
    expect(result.stop_sequences).toEqual(['#', 'EOF']);
  });

  it('translates Anthropic response to OpenAI Completion response', () => {
    const anthResponse = {
      id: 'msg_123',
      type: 'message' as const,
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'Clean code.' }],
      model: 'code-davinci-002',
      stop_reason: 'end_turn' as const,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20
      }
    };

    const result = toOpenAICompletionResponse(anthResponse, 'code-davinci-002');
    expect(result.object).toBe('text_completion');
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].text).toBe('Clean code.');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30
    });
  });

  it('translates OpenAI Completion response to Anthropic response', () => {
    const completionResponse = {
      id: 'cmpl-123',
      object: 'text_completion' as const,
      created: 123456789,
      model: 'claude-3-5-sonnet',
      choices: [
        {
          text: 'Helper response',
          index: 0,
          finish_reason: 'length' as const
        }
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 25,
        total_tokens: 40
      }
    };

    const result = toAnthropicResponseFromCompletion(completionResponse, 'claude-3-5-sonnet');
    expect(result.type).toBe('message');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Helper response' });
    expect(result.stop_reason).toBe('max_tokens');
    expect(result.usage).toEqual({
      input_tokens: 15,
      output_tokens: 25,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    });
  });
});

describe('worker completions routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes OpenAI completions request to Anthropic upstream messages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'msg_1',
        content: [{ type: 'text', text: 'Output result' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 10 }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/v1/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
        'x-upstream-url': 'https://api.anthropic.com',
        'x-upstream-format': 'anthropic'
      },
      body: JSON.stringify({
        model: 'claude-model',
        prompt: 'System context check',
        max_tokens: 50
      })
    });

    const res = await worker.fetch(request);
    expect(res.status).toBe(200);

    const data = await res.json() as OpenAICompletionResponse;
    expect(data.object).toBe('text_completion');
    expect(data.choices[0].text).toBe('Output result');

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'X-Api-Key': key
      })
    }));
  });

  it('routes Anthropic messages to OpenAI completions upstream', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'cmpl-1234',
        object: 'text_completion',
        choices: [{ text: 'Upstream response', index: 0, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 8 }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'x-upstream-url': 'https://api.openai.com/v1',
        'x-upstream-format': 'openai-completions'
      },
      body: JSON.stringify({
        model: 'code-davinci-002',
        messages: [{ role: 'user', content: 'Generate function' }]
      })
    });

    const res = await worker.fetch(request);
    expect(res.status).toBe(200);

    const data = await res.json() as AnthropicResponse;
    expect(data.type).toBe('message');
    const textBlock = data.content[0];
    expect(textBlock.type).toBe('text');
    if (textBlock.type === 'text') {
      expect(textBlock.text).toBe('Upstream response');
    }

    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/completions', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"prompt"')
    }));
  });

  it('routes OpenAI completions request to OpenAI Chat completions upstream', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Chat response text' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 8, completion_tokens: 12 }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/v1/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
        'x-upstream-url': 'https://api.openai.com/v1',
        'x-upstream-format': 'openai'
      },
      body: JSON.stringify({
        model: 'gpt-4',
        prompt: 'Check completion to chat translation',
        max_tokens: 60
      })
    });

    const res = await worker.fetch(request);
    expect(res.status).toBe(200);

    const data = await res.json() as OpenAICompletionResponse;
    expect(data.object).toBe('text_completion');
    expect(data.choices[0].text).toBe('Chat response text');

    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"messages"')
    }));
  });
});
