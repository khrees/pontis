import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAllClientsInfo, getClientInfo, ALL_CLIENTS } from "../src/cli/install-engine";
import { getAuthStatus } from "../src/cli/auth";
import { clearAllCredentials, storeOpenCodeApiKey } from "../src/secure-storage";
import { testConnectivity } from "../src/cli/client-launcher";
import { isFreeOpenCodeModel } from "../src/opencode-models";
import {
  getDefaultModelForProvider,
  getProviderDisplayName,
  resolveProviderAndModel,
  type ResolveInput,
} from "../src/cli/config";

describe("Client Info Listing", () => {
  it("returns info for all supported clients", () => {
    const clients = getAllClientsInfo();
    expect(clients.length).toBe(ALL_CLIENTS.length);

    const names = clients.map((c) => c.name);
    expect(names).toContain("claude");
    expect(names).toContain("codex");
    expect(names).toContain("opencode");
    expect(names).toContain("pi");
  });

  it("includes required metadata in client info", () => {
    const claudeInfo = getClientInfo("claude");
    expect(claudeInfo.displayName).toBe("Claude Code");
    expect(claudeInfo.description).toBeDefined();
    expect(claudeInfo.binary).toBe("claude");
    expect(typeof claudeInfo.installed).toBe("boolean");
    expect(claudeInfo.installHint).toContain("curl");
  });
});

describe("Auth Status", () => {
  beforeEach(() => {
    clearAllCredentials();
  });

  afterEach(() => {
    clearAllCredentials();
  });

  it("reports unconfigured when no key is present", () => {
    const status = getAuthStatus();
    expect(status.opencode.configured).toBe(false);
    expect(status.opencode.keyMasked).toBeNull();
  });

  it("reports configured with masked key when OpenCode key is saved", () => {
    storeOpenCodeApiKey("sk-opencode-test-api-key-value-123456789");
    const status = getAuthStatus();
    expect(status.opencode.configured).toBe(true);
    expect(status.opencode.keyMasked).toContain("sk-");
    expect(status.opencode.keyMasked).toContain("•••");
  });
});

describe("Connectivity Verification (testConnectivity)", () => {
  it("returns true on 200 OK response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "msg_123" }), { status: 200 }),
    );

    const ok = await testConnectivity("sk-valid-key", "claude-3-5-sonnet", "opencode");
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns false on 401 Unauthorized without continuing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 }),
    );

    const ok = await testConnectivity("invalid-key", "claude-3-5-sonnet", "opencode");
    expect(ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns false on 403 Forbidden without continuing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    );

    const ok = await testConnectivity("bad-token", "@cf/meta/llama-3.3-70b", "cloudflare");
    expect(ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns false on 500 Server Error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const ok = await testConnectivity("sk-key", "model-id", "local");
    expect(ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns false and identifies ModelError when upstream returns ModelError with 401", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ type: "error", error: { type: "ModelError", message: "Model qwen3.7-plus is not supported" } }), { status: 401 }),
    );

    const ok = await testConnectivity("sk-key", "qwen3.7-plus", "opencode");
    expect(ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns false on network connection failure", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    );

    const ok = await testConnectivity("sk-key", "model-id", "opencode");
    expect(ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("Free-tier model detection (isFreeOpenCodeModel)", () => {
  it("is the single definition used for Zen/Go routing and model lists", () => {
    expect(isFreeOpenCodeModel("mimo-v2.5-free")).toBe(true);
    expect(isFreeOpenCodeModel("big-pickle")).toBe(true);
    expect(isFreeOpenCodeModel("qwen3.7-plus")).toBe(false);
    expect(isFreeOpenCodeModel("@cf/meta/llama-3.3-70b")).toBe(false);
  });
});

describe("Provider & Model Resolution (resolveProviderAndModel)", () => {
  const resolve = (overrides: Partial<ResolveInput> = {}) =>
    resolveProviderAndModel({
      prefs: {},
      hasOpenCodeKey: false,
      hasCloudflareConfig: false,
      ...overrides,
    });

  it("prefers explicit flags over every other source", () => {
    const res = resolve({
      provider: "local",
      model: "qwen2.5-coder",
      envProvider: "cloudflare",
      prefs: { defaultProvider: "opencode", defaultModel: "mimo-v2.5-free" },
      hasOpenCodeKey: true,
    });
    expect(res.provider).toBe("local");
    expect(res.model).toBe("qwen2.5-coder");
  });

  it("falls back to environment over preferences", () => {
    const res = resolve({
      envProvider: "cloudflare",
      envModel: "@cf/zai-org/glm-5.2",
      prefs: { defaultProvider: "local", defaultModel: "llama3" },
    });
    expect(res.provider).toBe("cloudflare");
    expect(res.model).toBe("@cf/zai-org/glm-5.2");
  });

  it("treats an explicit upstream as the local provider", () => {
    expect(resolve({ upstream: "http://localhost:1234/v1" }).provider).toBe("local");
    expect(resolve({ envUpstream: "http://localhost:1234/v1" }).provider).toBe("local");
  });

  it("falls back to saved preferences", () => {
    const res = resolve({
      prefs: { defaultProvider: "cloudflare", defaultModel: "@cf/zai-org/glm-5.2" },
    });
    expect(res.provider).toBe("cloudflare");
    expect(res.model).toBe("@cf/zai-org/glm-5.2");
  });

  it("reuses the last-used model only for the same provider", () => {
    const same = resolve({
      prefs: { lastUsed: { provider: "local", model: "mistral" } },
    });
    expect(same.provider).toBe("local");
    expect(same.model).toBe("mistral");

    const different = resolve({
      prefs: { defaultProvider: "opencode", lastUsed: { provider: "local", model: "mistral" } },
    });
    expect(different.provider).toBe("opencode");
    expect(different.model).not.toBe("mistral");
  });

  it("detects the provider from stored credentials when nothing is configured", () => {
    expect(resolve({ hasOpenCodeKey: true }).provider).toBe("opencode");
    expect(resolve({ hasCloudflareConfig: true }).provider).toBe("cloudflare");
    expect(resolve({ hasOpenCodeKey: true, hasCloudflareConfig: true }).provider).toBe("opencode");
    expect(resolve({ prefs: { localEndpoint: "http://localhost:11434/v1" } }).provider).toBe("local");
  });

  it("ignores unrecognized provider strings instead of trusting them", () => {
    const res = resolve({
      provider: "garbage",
      envProvider: "also-garbage",
      prefs: { defaultProvider: "local" },
    });
    expect(res.provider).toBe("local");
  });

  it("defaults to opencode with a non-empty fallback model", () => {
    const res = resolve();
    expect(res.provider).toBe("opencode");
    expect(res.model).toBe(getDefaultModelForProvider("opencode"));
    expect(res.model.length).toBeGreaterThan(0);
  });

  it("never infers the provider from the model name", () => {
    // Model names say nothing about which provider should serve them.
    const res = resolve({ model: "@cf/moonshotai/kimi-k2.6", hasOpenCodeKey: true });
    expect(res.provider).toBe("opencode");
    expect(res.model).toBe("@cf/moonshotai/kimi-k2.6");
  });

  it("returns a non-empty default model for each provider", () => {
    for (const p of ["cloudflare", "local", "opencode"] as const) {
      expect(getDefaultModelForProvider(p).length).toBeGreaterThan(0);
    }
    expect(getDefaultModelForProvider("cloudflare")).toMatch(/^@cf\//);
    // Unknown providers fall back to the opencode default
    expect(getDefaultModelForProvider("nonsense")).toBe(getDefaultModelForProvider("opencode"));
    expect(getDefaultModelForProvider(null)).toBe(getDefaultModelForProvider("opencode"));
  });

  it("returns provider display names correctly", () => {
    expect(getProviderDisplayName("cloudflare")).toBe("Cloudflare AI Gateway");
    expect(getProviderDisplayName("local")).toBe("Local");
    expect(getProviderDisplayName("opencode")).toBe("OpenCode");
  });
});
