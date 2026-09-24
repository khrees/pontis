import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getPreferences,
  savePreferences,
  resetPreferences,
  updateLastUsed,
  getLastUsed,
} from "../src/cli/preferences";

describe("Preferences Management", () => {
  beforeEach(() => {
    resetPreferences();
  });

  afterEach(() => {
    resetPreferences();
  });

  it("returns empty preferences when not set", () => {
    const prefs = getPreferences();
    expect(prefs).toEqual({});
  });

  it("can save and retrieve preferences", () => {
    savePreferences({
      defaultProvider: "opencode",
      defaultModel: "mimo-v2.5-free",
      defaultClient: "claude",
    });

    const prefs = getPreferences();
    expect(prefs.defaultProvider).toBe("opencode");
    expect(prefs.defaultModel).toBe("mimo-v2.5-free");
    expect(prefs.defaultClient).toBe("claude");
  });

  it("merges partial preferences on save", () => {
    savePreferences({ defaultProvider: "opencode" });
    savePreferences({ defaultModel: "deepseek-v4-flash-free" });

    const prefs = getPreferences();
    expect(prefs.defaultProvider).toBe("opencode");
    expect(prefs.defaultModel).toBe("deepseek-v4-flash-free");
  });

  it("tracks and updates last used session", () => {
    updateLastUsed("codex", "local", "llama3");
    const last = getLastUsed();

    expect(last).not.toBeNull();
    expect(last?.client).toBe("codex");
    expect(last?.provider).toBe("local");
    expect(last?.model).toBe("llama3");
    expect(typeof last?.timestamp).toBe("number");
  });

  it("can reset preferences to empty state", () => {
    savePreferences({ defaultClient: "pi" });
    resetPreferences();
    expect(getPreferences()).toEqual({});
  });
});
