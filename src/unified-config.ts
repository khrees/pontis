/**
 * Unified configuration management for Pontis.
 * Centralizes all configuration options from environment variables, files, and defaults.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getCloudflareConfigSaved } from './cli/config';

/**
 * Configuration interface covering all Pontis settings
 */
export interface PontisConfig {
  // Provider settings
  provider: 'opencode' | 'local' | 'cloudflare';
  upstreamUrl?: string;
  upstreamFormat: 'openai' | 'anthropic' | 'openai-completions';
  
  // Model settings
  model?: string;
  defaultModel: string;
  visionModel: string;
  
  // Authentication
  openCodeApiKey?: string;
  cloudflareApiToken?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  localApiKey?: string;
  
  // Proxy settings
  proxyPort: number;
  proxyUrl: string;
  
  // Performance settings
  timeoutMs: number;
  minKeyLength: number;
  
  // Debugging
  debug: boolean;
  codexMode: boolean;
  
  // Paths
  pontisDir: string;
  configFile: string;
  logFile: string;
  
  // Streaming settings
  streamBufferSize: number;
  streamChunkSize: number;
  streamLowMemory: boolean;
  streamHighThroughput: boolean;
  streamLowLatency: boolean;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: PontisConfig = {
  provider: 'opencode',
  upstreamFormat: 'openai',
  defaultModel: 'mimo-v2.5-free',
  visionModel: 'qwen3.6-plus',
  proxyPort: 8787,
  proxyUrl: 'http://localhost:8787',
  timeoutMs: 120000,
  minKeyLength: 32,
  debug: false,
  codexMode: false,
  pontisDir: join(homedir(), '.pontis'),
  configFile: join(homedir(), '.pontis', 'config.json'),
  logFile: join(homedir(), '.pontis', 'proxy.log'),
  streamBufferSize: 5 * 1024 * 1024, // 5MB
  streamChunkSize: 64 * 1024, // 64KB
  streamLowMemory: false,
  streamHighThroughput: false,
  streamLowLatency: false,
};

/**
 * Load configuration from environment variables
 */
function loadEnvConfig(): Partial<PontisConfig> {
  const env = process.env || {};
  
  return {
    provider: (env.PONTIS_PROVIDER as PontisConfig['provider']) || DEFAULT_CONFIG.provider,
    upstreamUrl: env.PONTIS_UPSTREAM_URL,
    upstreamFormat: (env.PONTIS_UPSTREAM_FORMAT as PontisConfig['upstreamFormat']) || DEFAULT_CONFIG.upstreamFormat,
    model: env.PONTIS_MODEL,
    defaultModel: env.PONTIS_MODEL || DEFAULT_CONFIG.defaultModel,
    visionModel: env.PONTIS_VISION_MODEL || DEFAULT_CONFIG.visionModel,
    openCodeApiKey: env.OPENCODE_API_KEY,
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
    cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareGatewayId: env.CLOUDFLARE_GATEWAY_ID,
    localApiKey: env.LOCAL_API_KEY || env.OPENAI_API_KEY,
    proxyPort: env.PONTIS_PORT ? parseInt(env.PONTIS_PORT, 10) : DEFAULT_CONFIG.proxyPort,
    proxyUrl: env.PONTIS_PROXY_URL || DEFAULT_CONFIG.proxyUrl,
    timeoutMs: env.PONTIS_TIMEOUT_MS ? parseInt(env.PONTIS_TIMEOUT_MS, 10) : DEFAULT_CONFIG.timeoutMs,
    minKeyLength: env.PONTIS_MIN_KEY_LENGTH ? parseInt(env.PONTIS_MIN_KEY_LENGTH, 10) : DEFAULT_CONFIG.minKeyLength,
    debug: env.PONTIS_DEBUG === 'true',
    codexMode: env.PONTIS_CODEX_MODE === 'true',
    streamLowMemory: env.PONTIS_LOW_MEMORY === 'true',
    streamHighThroughput: env.PONTIS_HIGH_THROUGHPUT === 'true',
    streamLowLatency: env.PONTIS_LOW_LATENCY === 'true',
  };
}

/**
 * Load configuration from file
 */
function loadFileConfig(): Partial<PontisConfig> {
  const configPath = join(homedir(), '.pontis', 'config.json');
  
  if (!existsSync(configPath)) {
    return {};
  }
  
  try {
    const fileContent = readFileSync(configPath, 'utf-8');
    return JSON.parse(fileContent) as Partial<PontisConfig>;
  } catch (error) {
    console.warn(`Failed to load config file: ${error}`);
    return {};
  }
}

/**
 * Load Cloudflare-specific configuration
 */
function loadCloudflareConfig(): Partial<PontisConfig> {
  const saved = getCloudflareConfigSaved();
  
  if (!saved.apiToken) {
    return {};
  }
  
  return {
    cloudflareApiToken: saved.apiToken,
    cloudflareAccountId: saved.accountId,
    cloudflareGatewayId: saved.gatewayId,
  };
}

/**
 * Merge configuration sources with priority
 * Priority: Environment > File > Cloudflare Config > Defaults
 */
function mergeConfigs(...configs: Partial<PontisConfig>[]): PontisConfig {
  return configs.reduce((merged, config) => {
    return { ...merged, ...config };
  }, DEFAULT_CONFIG);
}

/**
 * Validate configuration
 */
function validateConfig(config: PontisConfig): PontisConfig {
  const validated = { ...config };
  
  // Validate provider
  if (!['opencode', 'local', 'cloudflare'].includes(validated.provider)) {
    console.warn(`Invalid provider: ${validated.provider}, defaulting to opencode`);
    validated.provider = 'opencode';
  }
  
  // Validate upstream format
  if (!['openai', 'anthropic', 'openai-completions'].includes(validated.upstreamFormat)) {
    console.warn(`Invalid upstream format: ${validated.upstreamFormat}, defaulting to openai`);
    validated.upstreamFormat = 'openai';
  }
  
  // Validate numeric values
  if (validated.timeoutMs < 1000) {
    console.warn(`Timeout too low: ${validated.timeoutMs}ms, setting to 1000ms`);
    validated.timeoutMs = 1000;
  }
  
  if (validated.minKeyLength < 0) {
    console.warn(`Invalid min key length: ${validated.minKeyLength}, setting to 0`);
    validated.minKeyLength = 0;
  }
  
  if (validated.proxyPort < 1 || validated.proxyPort > 65535) {
    console.warn(`Invalid proxy port: ${validated.proxyPort}, setting to 8787`);
    validated.proxyPort = 8787;
  }
  
  // Validate streaming buffer size
  if (validated.streamBufferSize < 1024 * 1024) { // Minimum 1MB
    console.warn(`Stream buffer size too low: ${validated.streamBufferSize}, setting to 1MB`);
    validated.streamBufferSize = 1024 * 1024;
  }
  
  return validated;
}

/**
 * Get current configuration
 */
export function getConfig(): PontisConfig {
  const envConfig = loadEnvConfig();
  const fileConfig = loadFileConfig();
  const cloudflareConfig = loadCloudflareConfig();
  
  const merged = mergeConfigs(envConfig, fileConfig, cloudflareConfig);
  return validateConfig(merged);
}

/**
 * Get a specific configuration value
 */
export function getConfigValue<K extends keyof PontisConfig>(key: K): PontisConfig[K] {
  const config = getConfig();
  return config[key];
}

/**
 * Update configuration (runtime only, not persisted)
 */
export function updateConfig(updates: Partial<PontisConfig>): PontisConfig {
  const current = getConfig();
  const updated = { ...current, ...updates };
  return validateConfig(updated);
}

/**
 * Save configuration to file
 */
export function saveConfig(config: Partial<PontisConfig>): void {
  const configPath = join(homedir(), '.pontis');
  const configFile = join(configPath, 'config.json');
  
  // Ensure directory exists
  const fs = require('fs');
  if (!existsSync(configPath)) {
    fs.mkdirSync(configPath, { mode: 0o700 });
  }
  
  // Only save non-sensitive values
  const safeConfig: Partial<PontisConfig> = {
    provider: config.provider,
    upstreamUrl: config.upstreamUrl,
    upstreamFormat: config.upstreamFormat,
    model: config.model,
    proxyPort: config.proxyPort,
    timeoutMs: config.timeoutMs,
    debug: config.debug,
    codexMode: config.codexMode,
    streamLowMemory: config.streamLowMemory,
    streamHighThroughput: config.streamHighThroughput,
    streamLowLatency: config.streamLowLatency,
  };
  
  fs.writeFileSync(configFile, JSON.stringify(safeConfig, null, 2), {
    mode: 0o600,
  });
}

/**
 * Reset configuration to defaults
 */
export function resetConfig(): PontisConfig {
  const configPath = join(homedir(), '.pontis', 'config.json');
  
  // Delete config file if it exists
  const fs = require('fs');
  if (existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
  
  return DEFAULT_CONFIG;
}

/**
 * Get configuration as environment variables (for subprocess spawning)
 */
export function getConfigAsEnvVars(): Record<string, string> {
  const config = getConfig();
  
  const envVars: Record<string, string> = {};
  
  if (config.provider) envVars.PONTIS_PROVIDER = config.provider;
  if (config.upstreamUrl) envVars.PONTIS_UPSTREAM_URL = config.upstreamUrl;
  if (config.upstreamFormat) envVars.PONTIS_UPSTREAM_FORMAT = config.upstreamFormat;
  if (config.model) envVars.PONTIS_MODEL = config.model;
  if (config.proxyPort) envVars.PONTIS_PORT = config.proxyPort.toString();
  if (config.proxyUrl) envVars.PONTIS_PROXY_URL = config.proxyUrl;
  if (config.timeoutMs) envVars.PONTIS_TIMEOUT_MS = config.timeoutMs.toString();
  if (config.minKeyLength !== undefined) envVars.PONTIS_MIN_KEY_LENGTH = config.minKeyLength.toString();
  if (config.debug) envVars.PONTIS_DEBUG = 'true';
  if (config.codexMode) envVars.PONTIS_CODEX_MODE = 'true';
  if (config.streamLowMemory) envVars.PONTIS_LOW_MEMORY = 'true';
  if (config.streamHighThroughput) envVars.PONTIS_HIGH_THROUGHPUT = 'true';
  if (config.streamLowLatency) envVars.PONTIS_LOW_LATENCY = 'true';
  
  return envVars;
}

/**
 * Validate if configuration is complete for a given provider
 */
export function validateProviderConfig(provider: PontisConfig['provider']): { valid: boolean; missing: string[] } {
  const config = getConfig();
  const missing: string[] = [];
  
  if (provider === 'opencode') {
    if (!config.openCodeApiKey && !process.env.OPENCODE_API_KEY) {
      missing.push('OPENCODE_API_KEY');
    }
  } else if (provider === 'cloudflare') {
    if (!config.cloudflareApiToken && !process.env.CLOUDFLARE_API_TOKEN) {
      missing.push('CLOUDFLARE_API_TOKEN');
    }
    if (!config.cloudflareAccountId && !process.env.CLOUDFLARE_ACCOUNT_ID) {
      missing.push('CLOUDFLARE_ACCOUNT_ID');
    }
  } else if (provider === 'local') {
    if (!config.upstreamUrl && !process.env.PONTIS_UPSTREAM_URL) {
      missing.push('PONTIS_UPSTREAM_URL');
    }
  }
  
  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Get configuration summary for display
 */
export function getConfigSummary(): string {
  const config = getConfig();
  
  const lines = [
    'Pontis Configuration:',
    `  Provider: ${config.provider}`,
    `  Model: ${config.model || config.defaultModel}`,
    `  Upstream: ${config.upstreamUrl || '(default)'}`,
    `  Format: ${config.upstreamFormat}`,
    `  Proxy Port: ${config.proxyPort}`,
    `  Timeout: ${config.timeoutMs}ms`,
    `  Debug: ${config.debug ? 'enabled' : 'disabled'}`,
  ];
  
  if (config.provider === 'cloudflare') {
    lines.push(`  Cloudflare Account: ${config.cloudflareAccountId || '(not set)'}`);
    lines.push(`  Cloudflare Gateway: ${config.cloudflareGatewayId || '(not set)'}`);
  }
  
  return lines.join('\n');
}