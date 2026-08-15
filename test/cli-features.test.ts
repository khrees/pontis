import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getAllClientsInfo, getClientInfo, ALL_CLIENTS } from "../src/cli/install-engine";
import { getAuthStatus } from "../src/cli/auth";
import { clearAllCredentials, storeOpenCodeApiKey } from "../src/secure-storage";

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
