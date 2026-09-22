import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/cli/ui", () => ({
  section: vi.fn(),
  badge: vi.fn(),
  kv: vi.fn(),
  select: vi.fn(),
  input: vi.fn(),
  createSpinner: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
  t: {
    primary: (s: string) => s,
    secondary: (s: string) => s,
    success: (s: string) => s,
    warning: (s: string) => s,
    error: (s: string) => s,
    muted: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    accent: (s: string) => s,
  },
  SYM: { bullet: "●" },
}));

import { createWizardSteps } from "../src/cli/wizard-steps";
import * as ui from "../src/cli/ui";

describe("Wizard Steps Definitions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers all 7 steps in proper order", () => {
    const steps = createWizardSteps();
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual([
      "resume",
      "provider",
      "credentials",
      "category",
      "model",
      "client",
      "review",
    ]);
  });

  it("skips resume step when no prior session exists", () => {
    const steps = createWizardSteps();
    const resumeStep = steps.find((s) => s.id === "resume")!;
    expect(resumeStep.canSkip?.({ env: {} })).toBe(true);
  });

  it("does not skip resume step when full last session is present", () => {
    const steps = createWizardSteps();
    const resumeStep = steps.find((s) => s.id === "resume")!;
    const canSkip = resumeStep.canSkip?.({
      env: {},
      lastUsed: { client: "claude", provider: "opencode", model: "mimo-v2.5-free" },
    });
    expect(canSkip).toBe(false);
  });

  it("handles back navigation from provider step", async () => {
    const steps = createWizardSteps();
    const providerStep = steps.find((s) => s.id === "provider")!;

    vi.mocked(ui.select).mockResolvedValueOnce({
      value: "__BACK__",
      index: -2,
      isBack: true,
    });

    const action = await providerStep.run({ env: {} });
    expect(action.type).toBe("back");
  });

  it("handles provider selection and resets model/category on change", async () => {
    const steps = createWizardSteps();
    const providerStep = steps.find((s) => s.id === "provider")!;

    vi.mocked(ui.select).mockResolvedValueOnce({
      value: "Google (Gemini)",
      index: 0,
    });

    const action = await providerStep.run({
      env: {},
      provider: "opencode",
      model: "mimo-v2.5-free",
      category: "chinese",
    });

    expect(action.type).toBe("next");
    if (action.type === "next") {
      expect(action.patch?.provider).toBe("google");
      expect(action.patch?.model).toBeUndefined();
      expect(action.patch?.category).toBeUndefined();
    }
  });

  it("supports jumping from review step to change model or provider", async () => {
    const steps = createWizardSteps();
    const reviewStep = steps.find((s) => s.id === "review")!;

    // Select "Change Model or Category" (index 1)
    vi.mocked(ui.select).mockResolvedValueOnce({
      value: "Change Model",
      index: 1,
    });

    const action = await reviewStep.run({
      env: {},
      provider: "opencode",
      model: "qwen3.8-flash",
      client: "claude",
    });

    expect(action.type).toBe("jump");
    if (action.type === "jump") {
      expect(action.stepId).toBe("category");
    }
  });

  it("handles back navigation from credentials step with existing key", async () => {
    const steps = createWizardSteps();
    const credsStep = steps.find((s) => s.id === "credentials")!;

    vi.mocked(ui.select).mockResolvedValueOnce({
      value: "__BACK__",
      index: -2,
      isBack: true,
    });

    const action = await credsStep.run({
      env: {},
      provider: "opencode",
      apiKey: "opc_existing_test_key",
    });

    expect(action.type).toBe("back");
  });

  it("handles using saved credentials from credentials step", async () => {
    const steps = createWizardSteps();
    const credsStep = steps.find((s) => s.id === "credentials")!;

    vi.mocked(ui.select).mockResolvedValueOnce({
      value: "Use saved API key",
      index: 0,
    });

    const action = await credsStep.run({
      env: {},
      provider: "opencode",
      apiKey: "opc_existing_test_key",
    });

    expect(action.type).toBe("next");
    if (action.type === "next") {
      expect(action.patch?.apiKey).toBe("opc_existing_test_key");
    }
  });

  it("handles back navigation from category step", async () => {
    const steps = createWizardSteps();
    const catStep = steps.find((s) => s.id === "category")!;

    vi.mocked(ui.select).mockResolvedValueOnce({
      value: "__BACK__",
      index: -2,
      isBack: true,
    });

    const action = await catStep.run({
      env: {},
      provider: "google",
      apiKey: "test-google-key",
    });

    expect(action.type).toBe("back");
  });
});
