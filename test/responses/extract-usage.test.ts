import { describe, it, expect } from "vitest";
import { extractUsage } from "../../src/translate/request/responses-to-chat";

describe("extractUsage", () => {
  it("extracts usage from a standard chat response", () => {
    const usage = extractUsage({
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(20);
    expect(usage.total_tokens).toBe(30);
  });

  it("handles usage with different key names", () => {
    const usage = extractUsage({
      usage: { input_tokens: 15, output_tokens: 25 },
    });
    expect(usage.input_tokens).toBe(15);
    expect(usage.output_tokens).toBe(25);
    expect(usage.total_tokens).toBe(40);
  });

  it("extracts cached tokens from prompt_tokens_details", () => {
    const usage = extractUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    });
    expect(usage.cache_read_input_tokens).toBe(30);
  });

  it("extracts cached tokens from input_tokens_details", () => {
    const usage = extractUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 20 },
      },
    });
    expect(usage.cache_read_input_tokens).toBe(20);
  });

  it("returns zeros for missing usage", () => {
    const usage = extractUsage({});
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
    expect(usage.total_tokens).toBe(0);
  });
});
