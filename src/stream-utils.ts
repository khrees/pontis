import { getMaxBufferBytes, getChunkSizeBytes } from './env';

let textEncoder: TextEncoder | null = null;
let textDecoder: TextDecoder | null = null;

export function getTextEncoder(): TextEncoder {
  if (!textEncoder) textEncoder = new TextEncoder();
  return textEncoder;
}

export function getTextDecoder(): TextDecoder {
  if (!textDecoder) textDecoder = new TextDecoder();
  return textDecoder;
}

export function resetTextDecoder(): void {
  if (textDecoder) textDecoder = new TextDecoder();
}

export interface StreamBufferConfig {
  maxSize: number;
  chunkSize: number;
  watermark: number;
}

export function getDefaultBufferConfig(): StreamBufferConfig {
  const maxSize = getMaxBufferBytes(5 * 1024 * 1024);
  const chunkSize = getChunkSizeBytes(64 * 1024);
  const watermark = Math.floor(maxSize * 0.8);
  return { maxSize, chunkSize, watermark };
}

export const DEFAULT_BUFFER_CONFIG: StreamBufferConfig = getDefaultBufferConfig();

export class StreamBufferManager {
  private buffer = '';
  public readonly config: StreamBufferConfig;
  private processedChunks = 0;

  constructor(config: StreamBufferConfig = DEFAULT_BUFFER_CONFIG) {
    this.config = config;
  }

  addChunk(chunk: string): void {
    this.buffer += chunk;
    this.processedChunks++;
  }

  isOverflow(): boolean {
    return this.buffer.length > this.config.maxSize;
  }

  isHighWatermark(): boolean {
    return this.buffer.length > this.config.watermark;
  }

  getSize(): number {
    return this.buffer.length;
  }

  getProcessedCount(): number {
    return this.processedChunks;
  }

  splitByDelimiter(delimiter: string): { parts: string[]; remaining: string } {
    const parts = this.buffer.split(delimiter);
    const remaining = parts.pop() || '';
    this.buffer = remaining;
    return { parts, remaining };
  }

  drain(): string {
    const data = this.buffer;
    this.buffer = '';
    return data;
  }

  clear(): void {
    this.buffer = '';
    this.processedChunks = 0;
  }

  peek(): string {
    return this.buffer;
  }
}

export class SSEEventProcessor {
  private decoder: TextDecoder;
  private bufferManager: StreamBufferManager;

  constructor(config?: StreamBufferConfig) {
    this.decoder = getTextDecoder();
    this.bufferManager = new StreamBufferManager(config);
  }

  async processChunk(
    chunk: Uint8Array,
    eventHandler: (event: string, data: string) => void
  ): Promise<void> {
    const text = this.decoder.decode(chunk, { stream: true });
    this.bufferManager.addChunk(text);

    if (this.bufferManager.isOverflow()) {
      throw new Error(
        `Stream buffer overflow: ${this.bufferManager.getSize()} > ${this.bufferManager.config.maxSize}`
      );
    }

    const { parts } = this.bufferManager.splitByDelimiter('\n\n');
    for (const part of parts) {
      if (!part.trim()) continue;
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        eventHandler('data', data);
      }
    }
  }

  finalize(eventHandler: (event: string, data: string) => void): void {
    const remaining = this.bufferManager.peek();
    if (remaining.trim()) {
      for (const line of remaining.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        eventHandler('data', data);
      }
    }
  }

  reset(): void {
    this.bufferManager.clear();
    resetTextDecoder();
    this.decoder = getTextDecoder();
  }

  getStats() {
    return {
      bufferSize: this.bufferManager.getSize(),
      processedChunks: this.bufferManager.getProcessedCount(),
      config: this.bufferManager.config,
    };
  }
}

export function createSSETransformer(
  eventHandler: (event: string, data: string) => void,
  config?: StreamBufferConfig
): TransformStream<Uint8Array, Uint8Array> {
  const processor = new SSEEventProcessor(config);

  return new TransformStream({
    async transform(chunk, controller) {
      try {
        await processor.processChunk(chunk, eventHandler);
      } catch (error) {
        controller.error(error);
      }
    },

    flush(controller) {
      try {
        processor.finalize(eventHandler);
      } catch (error) {
        controller.error(error);
      }
    },

    cancel() {
      processor.reset();
    }
  });
}

export function enqueueSSE(
  controller: ReadableStreamDefaultController<Uint8Array>,
  eventType: string,
  data: unknown
): void {
  const encoder = getTextEncoder();
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${payload}\n\n`));
}

export const STREAM_PRESETS = {
  lowLatency: {
    maxSize: 2 * 1024 * 1024,
    chunkSize: 16 * 1024,
    watermark: 1.5 * 1024 * 1024,
  } as StreamBufferConfig,

  balanced: DEFAULT_BUFFER_CONFIG,

  highThroughput: {
    maxSize: 10 * 1024 * 1024,
    chunkSize: 128 * 1024,
    watermark: 8 * 1024 * 1024,
  } as StreamBufferConfig,

  memoryConstrained: {
    maxSize: 1 * 1024 * 1024,
    chunkSize: 8 * 1024,
    watermark: 512 * 1024,
  } as StreamBufferConfig,
};

export function getOptimalBufferConfig(): StreamBufferConfig {
  if (typeof process !== 'undefined' && process.env) {
    const env = process.env;
    if (env.PONTIS_LOW_MEMORY === 'true') return STREAM_PRESETS.memoryConstrained;
    if (env.PONTIS_HIGH_THROUGHPUT === 'true') return STREAM_PRESETS.highThroughput;
    if (env.PONTIS_LOW_LATENCY === 'true') return STREAM_PRESETS.lowLatency;
  }
  return STREAM_PRESETS.balanced;
}