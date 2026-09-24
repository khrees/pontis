import { describe, it, expect, vi } from "vitest";
import {
  WizardStateMachine,
  type WizardContext,
  type WizardStepDefinition,
} from "../src/cli/wizard-machine";

describe("WizardStateMachine", () => {
  const defaultContext: WizardContext = {
    env: {},
  };

  it("navigates forward linearly through steps", async () => {
    const steps: WizardStepDefinition[] = [
      {
        id: "provider",
        title: "Select Provider",
        run: async () => ({ type: "next", patch: { provider: "opencode" } }),
      },
      {
        id: "category",
        title: "Select Category",
        run: async () => ({ type: "next", patch: { category: "chinese" } }),
      },
      {
        id: "model",
        title: "Select Model",
        run: async () => ({ type: "next", patch: { model: "qwen3.8-flash" } }),
      },
    ];

    const machine = new WizardStateMachine(defaultContext, steps);
    const result = await machine.run("provider");

    expect(result).not.toBeNull();
    expect(result?.provider).toBe("opencode");
    expect(result?.category).toBe("chinese");
    expect(result?.model).toBe("qwen3.8-flash");
    expect(machine.getHistory()).toEqual(["provider", "category", "model"]);
  });

  it("supports 'back' navigation to previous step with preserved context", async () => {
    let categoryAttempts = 0;

    const steps: WizardStepDefinition[] = [
      {
        id: "provider",
        title: "Select Provider",
        run: async (ctx) => {
          return {
            type: "next",
            patch: { provider: ctx.provider ? "cloudflare" : "opencode" },
          };
        },
      },
      {
        id: "category",
        title: "Select Category",
        run: async () => {
          categoryAttempts++;
          if (categoryAttempts === 1) {
            // First time: go back to provider
            return { type: "back" };
          }
          // Second time: proceed forward
          return { type: "next", patch: { category: "frontier" } };
        },
      },
      {
        id: "model",
        title: "Select Model",
        run: async () => ({ type: "next", patch: { model: "gpt-oss:120b" } }),
      },
    ];

    const machine = new WizardStateMachine(defaultContext, steps);
    const result = await machine.run("provider");

    expect(categoryAttempts).toBe(2);
    expect(result?.provider).toBe("cloudflare"); // Updated after backing to provider
    expect(result?.category).toBe("frontier");
    expect(result?.model).toBe("gpt-oss:120b");
  });

  it("returns null when backing out from the very first step", async () => {
    const steps: WizardStepDefinition[] = [
      {
        id: "provider",
        title: "Select Provider",
        run: async () => ({ type: "back" }),
      },
    ];

    const machine = new WizardStateMachine(defaultContext, steps);
    const result = await machine.run("provider");

    expect(result).toBeNull();
  });

  it("supports 'jump' action to jump directly to an earlier step (e.g. from review)", async () => {
    let reviewCount = 0;

    const steps: WizardStepDefinition[] = [
      {
        id: "provider",
        title: "Select Provider",
        run: async () => ({ type: "next", patch: { provider: "opencode" } }),
      },
      {
        id: "model",
        title: "Select Model",
        run: async (ctx) => ({
          type: "next",
          patch: { model: ctx.model ? "deepseek-v4.1-flash" : "qwen3.5:latest" },
        }),
      },
      {
        id: "review",
        title: "Review",
        run: async () => {
          reviewCount++;
          if (reviewCount === 1) {
            // Jump back to model step to change model
            return { type: "jump", stepId: "model" };
          }
          // Second time: confirm and launch
          return { type: "next" };
        },
      },
    ];

    const machine = new WizardStateMachine(defaultContext, steps);
    const result = await machine.run("provider");

    expect(reviewCount).toBe(2);
    expect(result?.model).toBe("deepseek-v4.1-flash");
  });

  it("skips steps where canSkip returns true", async () => {
    const steps: WizardStepDefinition[] = [
      {
        id: "resume",
        title: "Resume",
        canSkip: () => true, // Skipped
        run: async () => ({ type: "next", patch: { launchDirectly: true } }),
      },
      {
        id: "provider",
        title: "Provider",
        run: async () => ({ type: "next", patch: { provider: "local" } }),
      },
    ];

    const machine = new WizardStateMachine(defaultContext, steps);
    const result = await machine.run("resume");

    expect(result?.launchDirectly).toBeUndefined();
    expect(result?.provider).toBe("local");
  });

  it("renders breadcrumbs without crashing", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const steps: WizardStepDefinition[] = [
      {
        id: "provider",
        title: "Provider",
        run: async () => ({ type: "next", patch: { provider: "opencode" } }),
      },
      {
        id: "model",
        title: "Model",
        run: async () => ({ type: "next", patch: { model: "mimo-v2.5-free" } }),
      },
    ];

    const machine = new WizardStateMachine(
      { ...defaultContext, provider: "opencode" },
      steps,
    );
    machine.renderBreadcrumbs("provider");

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
