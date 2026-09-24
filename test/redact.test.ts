import { describe, it, expect } from "vitest";
import { redactKey } from "../src/redact";

describe("redactKey", () => {
  it("returns empty string for undefined, null, or empty input", () => {
    expect(redactKey(undefined)).toBe("");
    expect(redactKey(null)).toBe("");
    expect(redactKey("")).toBe("");
  });

  it("fully masks short values (≤8 chars)", () => {
    expect(redactKey("abc")).toBe("•••");
    expect(redactKey("abcdefgh")).toBe("••••••••");
  });

  it("shows first 4 and last 4 characters for longer values", () => {
    expect(redactKey("sk-abcdefghijklmnopqrstuvwxyz123456")).toBe(
      "sk-a•••3456",
    );
    expect(redactKey("local-model-dummy-api-key-value-32-chars-long")).toBe(
      "loca•••long",
    );
  });
});
