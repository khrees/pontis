/**
 * Streaming utilities for optimized encoder/decoder reuse and buffer management.
 * Reduces memory allocation overhead in streaming operations.
 */

// TextEncoder and TextDecoder instances for reuse
let textEncoder: TextEncoder | null = null;
let textDecoder: TextDecoder | null = null;

/**
 * Get a reusable TextEncoder instance.
 * Creates one on first call and reuses it for subsequent calls.
 */
export function getTextEncoder(): TextEncoder {
  if (!textEncoder) {
    textEncoder = new TextEncoder();
  }
  return textEncoder;
}

/**
 * Get a reusable TextDecoder instance.
 * Creates one on first call and reuses it for subsequent calls.
 */
export function getTextDecoder(): TextDecoder {
  if (!textDecoder) {
    textDecoder = new TextDecoder();
  }
  return textDecoder;
}

/**
 * Reset the decoder state (useful when processing independent streams).
 * This prevents carryover between different streaming operations.
 */
export function resetTextDecoder(): void {
  if (textDecoder) {
    textDecoder = new TextDecoder(); // Create fresh instance
  }
}

/**
 * Stream buffer configuration
 */
export interface StreamBufferConfig {
  maxSize: number;        // Maximum buffer size in bytes
  chunkSize: number;      // Preferred chunk size for processing
  watermark: number;      // High watermark for proactive processing
}

/**
 * Default buffer configuration optimized for typical AI streaming scenarios
 */
export const DEFAULT_BUFFER_CONFIG: StreamBufferConfig = {
  maxSize: 5 * 1024 * 1024,  // 5MB (reduced from 10MB)
  chunkSize: 64 * 1024,       // 64KB chunks
  watermark: 4 * 1024 * 1024, // 4MB watermark (80% of max)
};

/**
 * Stream buffer manager for efficient memory usage
 */
export class StreamBufferManager {
  private buffer: string = '';
  private config: StreamBufferConfig;
  private processedChunks: number = 0;

  constructor(config: StreamBufferConfig = DEFAULT_BUFFER_CONFIG) {
    this.config = config;
  }

  /**
   * Add data to the buffer
   */
  addChunk(chunk: string): void {
    this.buffer += chunk;
    this.processedChunks++;
  }

  /**
   * Check if buffer exceeds maximum size
   */
  isOverflow(): boolean {
    return this.buffer.length > this.config.maxSize;
  }

  /**
   * Check if buffer exceeds high watermark
   */
  isHighWatermark(): boolean {
    return this.buffer.length > this.config.watermark;
  }

  /**
   * Get current buffer size
   */
  getSize(): number {
    return this.buffer.length;
  }

  /**
   * Get processed chunk count
   */
  getProcessedCount(): number {
    return this.processedChunks;
  }

  /**
   * Split buffer by delimiter and return parts
   * Returns array of complete messages and remaining buffer
   */
  splitByDelimiter(delimiter: string): { parts: string[]; remaining: string } {
    const parts = this.buffer.split(delimiter);
    const remaining = parts.pop() || '';
    this.buffer = remaining;
    return { parts, remaining };
  }

  /**
   * Get and clear buffer
   */
  drain(): string {
    const data = this.buffer;
    this.buffer = '';
    return data;
  }

  /**
   * Clear buffer
   */
  clear(): void {
    this.buffer = '';
    this.processedChunks = 0;
  }

  /**
   * Get current buffer content without clearing
   */
  peek(): string {
    return this.buffer;
  }
}

/**
 * Optimized SSE event processor with reusable components
 */
export class SSEEventProcessor {
  private encoder: TextEncoder;
  private decoder: TextDecoder;
  private bufferManager: StreamBufferManager;

  constructor(config?: StreamBufferConfig) {
    this.encoder = getTextEncoder();
    this.decoder = getTextDecoder();
    this.bufferManager = new StreamBufferManager(config);
  }

  /**
   * Process a raw chunk from the stream
   */
  async processChunk(
    chunk: Uint8Array,
    eventHandler: (event: string, data: string) => void
  ): Promise<void> {
    // Decode chunk using reusable decoder
    const text = this.decoder.decode(chunk, { stream: true });
    
    // Add to buffer
    this.bufferManager.addChunk(text);

    // Check for overflow
    if (this.bufferManager.isOverflow()) {
      throw new Error(
        `Stream buffer overflow: ${this.bufferManager.getSize()} > ${this.bufferManager.config.maxSize}`
      );
    }

    // Process complete SSE events
    const { parts } = this.bufferManager.splitByDelimiter('\n\n');
    
    for (const part of parts) {
      if (!part.trim()) continue;
      
      const lines = part.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        
        eventHandler('data', data);
      }
    }
  }

  /**
   * Finalize processing (handle remaining buffer)
   */
  finalize(eventHandler: (event: string, data: string) => void): void {
    const remaining = this.bufferManager.peek();
    if (remaining.trim()) {
      const lines = remaining.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        
        eventHandler('data', data);
      }
    }
  }

  /**
   * Reset the processor for a new stream
   */
  reset(): void {
    this.bufferManager.clear();
    resetTextDecoder();
    this.decoder = getTextDecoder();
  }

  /**
   * Get buffer statistics
   */
  getStats() {
    return {
      bufferSize: this.bufferManager.getSize(),
      processedChunks: this.bufferManager.getProcessedCount(),
      config: this.bufferManager.config,
    };
  }
}

/**
 * Factory function to create an optimized SSE stream transformer
 */
export function createSSETransformer(
  eventHandler: (event: string, data: string) => void,
  config?: StreamBufferConfig
): TransformStream<Uint8Array, Uint8Array> {
  const processor = new SSEEventProcessor(config);
  const encoder = getTextEncoder();

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

/**
 * Utility to enqueue SSE data with reusable encoder
 */
export function enqueueSSE(
  controller: ReadableStreamDefaultController<Uint8Array>,
  eventType: string,
  data: unknown
): void {
  const encoder = getTextEncoder();
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const message = `event: ${eventType}\ndata: ${payload}\n\n`;
  controller.enqueue(encoder.encode(message));
}

/**
 * Configuration presets for different streaming scenarios
 */
export const STREAM_PRESETS = {
  // Low latency for real-time chat
  lowLatency: {
    maxSize: 2 * 1024 * 1024,   // 2MB
    chunkSize: 16 * 1024,       // 16KB
    watermark: 1.5 * 1024 * 1024, // 1.5MB
  } as StreamBufferConfig,

  // Balanced for typical AI responses
  balanced: DEFAULT_BUFFER_CONFIG,

  // High throughput for large responses
  highThroughput: {
    maxSize: 10 * 1024 * 1024,  // 10MB
    chunkSize: 128 * 1024,      // 128KB
    watermark: 8 * 1024 * 1024, // 8MB
  } as StreamBufferConfig,

  // Memory constrained environments
  memoryConstrained: {
    maxSize: 1 * 1024 * 1024,   // 1MB
    chunkSize: 8 * 1024,        // 8KB
    watermark: 512 * 1024,      // 512KB
  } as StreamBufferConfig,
};

/**
 * Get appropriate buffer configuration based on environment
 */
export function getOptimalBufferConfig(): StreamBufferConfig {
  // Check if we're in a memory-constrained environment
  if (typeof process !== 'undefined' && process.env) {
    const env = process.env;
    
    if (env.PONTIS_LOW_MEMORY === 'true') {
      return STREAM_PRESETS.memoryConstrained;
    }
    
    if (env.PONTIS_HIGH_THROUGHPUT === 'true') {
      return STREAM_PRESETS.highThroughput;
    }
    
    if (env.PONTIS_LOW_LATENCY === 'true') {
      return STREAM_PRESETS.lowLatency;
    }
  }

  // Default to balanced configuration
  return STREAM_PRESETS.balanced;
}