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

export interface StreamBufferConfig {
  maxSize: number;
  chunkSize: number;
  watermark: number;
}

function getDefaultBufferConfig(): StreamBufferConfig {
  const maxSize = getMaxBufferBytes(5 * 1024 * 1024);
  const chunkSize = getChunkSizeBytes(64 * 1024);
  const watermark = Math.floor(maxSize * 0.8);
  return { maxSize, chunkSize, watermark };
}

const STREAM_PRESETS = {
  lowLatency: {
    maxSize: 2 * 1024 * 1024,
    chunkSize: 16 * 1024,
    watermark: 1.5 * 1024 * 1024,
  } as StreamBufferConfig,

  balanced: getDefaultBufferConfig(),

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