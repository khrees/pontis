import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getEnv,
  getEnvAsNumber,
  getEnvAsBoolean,
  getProvider,
  getModel,
  getUpstreamUrl,
  getUpstreamFormat,
  getPort,
  getHost,
  getRedirectPort,
  getZenUpstream,
  getGoUpstream,
  getMaxBufferBytes,
  getChunkSizeBytes,
  getCacheMaxTurns,
  getCacheTtlMs,
  getMinKeyLength,
  isCodexMode,
  getTimeoutMs,
  hasProcess,
  isDebug,
} from "../src/env";

describe("env accessor helpers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset relevant env vars
    delete process.env.PONTIS_PROVIDER;
    delete process.env.PONTIS_MODEL;
    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
    delete process.env.PONTIS_PORT;
    delete process.env.PORT;
    delete process.env.PONTIS_HOST;
    delete process.env.PONTIS_REDIRECT_PORT;
    delete process.env.PONTIS_ZEN_UPSTREAM;
    delete process.env.PONTIS_GO_UPSTREAM;
    delete process.env.PONTIS_MAX_BUFFER_MB;
    delete process.env.PONTIS_MAX_BUFFER_BYTES;
    delete process.env.PONTIS_CHUNK_SIZE_KB;
    delete process.env.PONTIS_CHUNK_SIZE_BYTES;
    delete process.env.PONTIS_CACHE_MAX_TURNS;
    delete process.env.PONTIS_CACHE_TTL_MS;
    delete process.env.PONTIS_MIN_KEY_LENGTH;
    delete process.env.PONTIS_CODEX_MODE;
    delete process.env.PONTIS_TIMEOUT_MS;
    delete process.env.PONTIS_DEBUG;
    delete process.env.TEST_STR;
    delete process.env.TEST_NUM;
    delete process.env.TEST_BOOL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("handles string getters with and without fallbacks", () => {
    expect(getEnv("TEST_STR")).toBe("");
    expect(getEnv("TEST_STR", "default_val")).toBe("default_val");
    process.env.TEST_STR = "custom_val";
    expect(getEnv("TEST_STR", "default_val")).toBe("custom_val");
  });

  it("handles number getters with fallback and min bounds", () => {
    expect(getEnvAsNumber("TEST_NUM", 42)).toBe(42);
    expect(getEnvAsNumber("TEST_NUM", 42, 10)).toBe(42);

    process.env.TEST_NUM = "invalid";
    expect(getEnvAsNumber("TEST_NUM", 42)).toBe(42);

    process.env.TEST_NUM = "5";
    expect(getEnvAsNumber("TEST_NUM", 42, 10)).toBe(10); // clamped to min

    process.env.TEST_NUM = "100";
    expect(getEnvAsNumber("TEST_NUM", 42, 10)).toBe(100);
  });

  it("handles boolean getters", () => {
    expect(getEnvAsBoolean("TEST_BOOL")).toBe(false);
    process.env.TEST_BOOL = "false";
    expect(getEnvAsBoolean("TEST_BOOL")).toBe(false);
    process.env.TEST_BOOL = "true";
    expect(getEnvAsBoolean("TEST_BOOL")).toBe(true);
  });

  it("provides defaults for named config accessors", () => {
    expect(getProvider()).toBe("");
    expect(getModel()).toBe("");
    expect(getUpstreamUrl()).toBe("");
    expect(getUpstreamFormat()).toBe("openai");
    expect(getPort()).toBe(8787);
    expect(getHost()).toBe("127.0.0.1");
    expect(getRedirectPort()).toBe(8443);
    expect(getZenUpstream()).toBe("https://opencode.ai/zen/v1");
    expect(getGoUpstream()).toBe("https://opencode.ai/zen/go/v1");
    expect(getMaxBufferBytes()).toBe(5 * 1024 * 1024);
    expect(getChunkSizeBytes()).toBe(64 * 1024);
    expect(getCacheMaxTurns()).toBe(50);
    expect(getCacheTtlMs()).toBe(5 * 60 * 1000);
    expect(getMinKeyLength()).toBe(32);
    expect(isCodexMode()).toBe(false);
    expect(getTimeoutMs()).toBe(120000);
    expect(hasProcess()).toBe(true);
    expect(isDebug()).toBe(false);
  });

  it("reads overridden named config accessors", () => {
    process.env.PONTIS_PROVIDER = "CloudFlare";
    expect(getProvider()).toBe("cloudflare");

    process.env.PONTIS_MODEL = "custom-model";
    expect(getModel()).toBe("custom-model");

    process.env.PONTIS_UPSTREAM_URL = "https://custom.upstream.org";
    expect(getUpstreamUrl()).toBe("https://custom.upstream.org");

    process.env.PONTIS_UPSTREAM_FORMAT = "Anthropic";
    expect(getUpstreamFormat()).toBe("anthropic");

    process.env.PONTIS_MAX_BUFFER_MB = "10";
    expect(getMaxBufferBytes()).toBe(10 * 1024 * 1024);

    process.env.PONTIS_CHUNK_SIZE_KB = "128";
    expect(getChunkSizeBytes()).toBe(128 * 1024);

    process.env.PONTIS_MIN_KEY_LENGTH = "16";
    expect(getMinKeyLength()).toBe(16);

    process.env.PONTIS_CODEX_MODE = "true";
    expect(isCodexMode()).toBe(true);

    process.env.PONTIS_TIMEOUT_MS = "60000";
    expect(getTimeoutMs()).toBe(60000);

    process.env.PONTIS_DEBUG = "true";
    expect(isDebug()).toBe(true);
  });
});
