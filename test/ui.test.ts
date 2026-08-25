import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { select } from "../src/cli/ui";

describe("Interactive UI Selection (select)", () => {
  let originalStdinIsTTY: boolean | undefined;

  beforeEach(() => {
    originalStdinIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("navigates and selects using Tab / Arrow key events in TTY mode", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    (process.stdin as any).setRawMode = vi.fn();

    const selectPromise = select("Pick an option", ["Option A", "Option B", "Option C"], {
      allowCustom: false,
      defaultIndex: 0,
    });

    // Simulate Tab keypress -> Moves from Option A (0) to Option B (1)
    process.stdin.emit("keypress", "", { name: "tab", shift: false });

    // Simulate Return keypress -> Selects Option B
    process.stdin.emit("keypress", "", { name: "return" });

    const result = await selectPromise;
    expect(result).toEqual({ value: "Option B", index: 1 });
  });

  it("navigates backwards using Shift+Tab in TTY mode", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    (process.stdin as any).setRawMode = vi.fn();

    const selectPromise = select("Pick an option", ["Option A", "Option B", "Option C"], {
      allowCustom: false,
      defaultIndex: 0,
    });

    // Simulate Shift+Tab keypress -> Wraps from Option A (0) to Option C (2)
    process.stdin.emit("keypress", "", { name: "tab", shift: true });

    // Simulate Return keypress -> Selects Option C
    process.stdin.emit("keypress", "", { name: "return" });

    const result = await selectPromise;
    expect(result).toEqual({ value: "Option C", index: 2 });
  });

  it("selects immediately with numeric hotkey (e.g. '2')", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    (process.stdin as any).setRawMode = vi.fn();

    const selectPromise = select("Pick an option", ["Option A", "Option B", "Option C"], {
      allowCustom: false,
    });

    // Simulate pressing key '3'
    process.stdin.emit("keypress", "3", { name: "3" });

    const result = await selectPromise;
    expect(result).toEqual({ value: "Option C", index: 2 });
  });
});
