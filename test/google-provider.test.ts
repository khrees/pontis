import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchGoogleModels,
  setupGoogleInteractive,
  getGoogleApiKeyInteractive,
  GOOGLE_DEFAULT_MODELS,
} from "../src/cli/provider-google";
import {
  storeGoogleApiKey,
  retrieveGoogleApiKey,
  deleteGoogleApiKey,
  clearAllCredentials,
} from "../src/secure-storage";
import {
  normalizeProvider,
  getDefaultModelForProvider,
  getProviderDisplayName,
  isModelCompatibleWithProvider,
  resolveProviderAndModel,
} from "../src/cli/config";
import {
  resolveModel,
} from "../src/config";
import * as ui from "../src/cli/ui";

describe("Google Provider", () => {
  beforeEach(() => {
    clearAllCredentials();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearAllCredentials();
    vi.restoreAllMocks();
  });

  describe("Credentials Storage", () => {
    it("should store and retrieve Google API key", () => {
      storeGoogleApiKey("test-google-api-key-12345");
      expect(retrieveGoogleApiKey()).toBe("test-google-api-key-12345");
    });

    it("should delete Google credentials cleanly", () => {
      storeGoogleApiKey("test-google-api-key");
      deleteGoogleApiKey();
      expect(retrieveGoogleApiKey()).toBeNull();
    });
  });

  describe("Configuration and Normalization", () => {
    it("should normalize provider aliases", () => {
      expect(normalizeProvider("google")).toBe("google");
      expect(normalizeProvider("gemini")).toBe("google");
    });

    it("should return default model for Google provider", () => {
      expect(getDefaultModelForProvider("google")).toBe("gemini-2.5-flash");
    });

    it("should return human-friendly display name", () => {
      expect(getProviderDisplayName("google")).toBe("Google (Gemini)");
    });

    it("should validate model compatibility with Google provider", () => {
      expect(isModelCompatibleWithProvider("gemini-2.5-flash", "google")).toBe(true);
      expect(isModelCompatibleWithProvider("gemini-2.5-pro", "google")).toBe(true);
      expect(isModelCompatibleWithProvider("gemma-2-27b-it", "google")).toBe(true);
      expect(isModelCompatibleWithProvider("@cf/meta/llama", "google")).toBe(false);
    });

    it("should resolve Google provider when Google key is present", () => {
      const resolved = resolveProviderAndModel({
        prefs: {},
        hasOpenCodeKey: false,
        hasCloudflareConfig: false,
        hasGoogleKey: true,
      });
      expect(resolved.provider).toBe("google");
      expect(resolved.model).toBe("gemini-2.5-flash");
    });
  });

  describe("Model Resolution and Fetching", () => {
    it("should preserve gemini and gemma models in resolveModel", () => {
      expect(resolveModel("gemini-2.5-flash")).toBe("gemini-2.5-flash");
      expect(resolveModel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
      expect(resolveModel("gemma-2-27b-it")).toBe("gemma-2-27b-it");
    });

    it("should return default Google models when API call fails", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network down"));
      const models = await fetchGoogleModels("fake-key");
      expect(models).toEqual(GOOGLE_DEFAULT_MODELS);
    });

    it("should parse models from Google Generative Language API", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: "models/gemini-2.5-flash" },
            { name: "models/gemini-2.5-pro" },
            { name: "models/gemma-2-9b-it" },
            { name: "models/embedding-001" },
          ],
        }),
      } as any);

      const models = await fetchGoogleModels("valid-key");
      expect(models).toEqual([
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemma-2-9b-it",
      ]);
    });
  });

  describe("Interactive Google AI Studio API Key Setup", () => {
    it("should prompt for Google AI Studio API key and save it", async () => {
      vi.spyOn(ui, "input").mockResolvedValueOnce("ai-studio-key-12345");
      const key = await getGoogleApiKeyInteractive();
      expect(key).toBe("ai-studio-key-12345");
      expect(retrieveGoogleApiKey()).toBe("ai-studio-key-12345");
    });

    it("should complete setupGoogleInteractive with selected model", async () => {
      vi.spyOn(ui, "input").mockResolvedValueOnce("ai-studio-key-12345");
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: "models/gemini-2.5-flash" },
            { name: "models/gemini-2.5-pro" },
          ],
        }),
      } as any);
      vi.spyOn(ui, "select").mockResolvedValueOnce({ index: 0, value: "gemini-2.5-flash" });

      const setup = await setupGoogleInteractive();
      expect(setup.apiKey).toBe("ai-studio-key-12345");
      expect(setup.model).toBe("gemini-2.5-flash");
      expect(setup.upstreamUrl).toBeDefined();
    });
  });
});
