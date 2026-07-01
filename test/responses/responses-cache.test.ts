import { describe, it, expect, beforeEach } from "vitest";
import { ResponsesCache } from "../../src/responses-cache";
import { emptyResponsesUsage } from "../helpers";

describe("ResponsesCache", () => {
  beforeEach(() => {
    // Create a fresh cache for each test (small TTL so stale eviction can be tested)
  });

  it("stores and retrieves entries", () => {
    const cache = new ResponsesCache(10);
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "mimo-v2.5-free",
      originalModel: "gpt-4",
      fullMessages: [{ role: "user", content: "hi" }],
      usage: emptyResponsesUsage({ input_tokens: 10, output_tokens: 5 }),
    });
    const entry = cache.get("resp_1");
    expect(entry).toBeDefined();
    expect(entry!.responseId).toBe("resp_1");
    expect(entry!.fullMessages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("returns undefined for unknown keys", () => {
    const cache = new ResponsesCache(10);
    expect(cache.get("unknown")).toBeUndefined();
  });

  it("evicts stale entries past TTL", async () => {
    const cache = new ResponsesCache(10, 10); // 10ms TTL
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get("resp_1")).toBeUndefined();
  });

  it("evicts oldest entries when at capacity (LRU)", () => {
    const cache = new ResponsesCache(2, 60000);
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    cache.set("resp_2", {
      responseId: "resp_2",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    cache.set("resp_3", {
      responseId: "resp_3",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    expect(cache.get("resp_1")).toBeUndefined();
    expect(cache.get("resp_2")).toBeDefined();
    expect(cache.get("resp_3")).toBeDefined();
  });

  it("promotes entries to front on access (LRU)", () => {
    const cache = new ResponsesCache(2, 60000);
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    cache.set("resp_2", {
      responseId: "resp_2",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    cache.get("resp_1");
    cache.set("resp_3", {
      responseId: "resp_3",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    expect(cache.get("resp_1")).toBeDefined();
    expect(cache.get("resp_2")).toBeUndefined();
    expect(cache.get("resp_3")).toBeDefined();
  });

  it("lists keys from newest to oldest", () => {
    const cache = new ResponsesCache(10, 60000);
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    cache.set("resp_2", {
      responseId: "resp_2",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    const keys = cache.keys();
    expect(keys[0]).toBe("resp_2");
    expect(keys[1]).toBe("resp_1");
  });

  it("reports correct size", () => {
    const cache = new ResponsesCache(10);
    expect(cache.size).toBe(0);
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    expect(cache.size).toBe(1);
  });
});
