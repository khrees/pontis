import { existsSync, rmSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  categorizeOpenCodeModels,
  compareModelVersionsDesc,
  setupOpenCodeInteractive,
} from "../src/cli/provider-opencode";
import {
  storeOpenCodeApiKey,
  clearAllCredentials,
} from "../src/secure-storage";
import { CACHE_FILE } from "../src/cli/config";
import * as ui from "../src/cli/ui";

const ALL_88_OPENCODE_MODELS = [
  "big-pickle",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
  "gemini-3-flash",
  "gemini-3.1-pro",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "glm-5",
  "glm-5.1",
  "glm-5.2",
  "glm-5.3",
  "glm-5.3-flash",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-nano",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "grok-4.5",
  "grok-4.6",
  "grok-4.7",
  "grok-build-0.1",
  "hy3",
  "hy4-preview",
  "jev-1.13",
  "jev-1.13-free",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k3",
  "ling-3.0-flash-fin-free",
  "longcat-2.0",
  "mimo-v2.5",
  "mimo-v2.5-free",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-flash-free",
  "mimo-v2.6-pro",
  "minimax-m2.5",
  "minimax-m2.7",
  "minimax-m3",
  "muse-spark-1.2",
  "muse-spark-1.2-contributor",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3",
  "muse-spark-1.3-contributor",
  "muse-spark-1.3-contributor-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "omen-alpha",
  "qwen3.5-plus",
  "qwen3.6-plus",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.8-flash",
  "qwen3.8-max",
];

describe("OpenCode Provider Four Categories & Sorting", () => {
  beforeEach(() => {
    clearAllCredentials();
    if (existsSync(CACHE_FILE)) {
      try { rmSync(CACHE_FILE, { force: true }); } catch {}
    }
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearAllCredentials();
    if (existsSync(CACHE_FILE)) {
      try { rmSync(CACHE_FILE, { force: true }); } catch {}
    }
    vi.restoreAllMocks();
  });

  describe("compareModelVersionsDesc", () => {
    it("sorts higher major and minor versions before lower ones", () => {
      expect(compareModelVersionsDesc("claude-opus-5", "claude-opus-4-8")).toBeLessThan(0);
      expect(compareModelVersionsDesc("claude-opus-4-8", "claude-opus-4-7")).toBeLessThan(0);
      expect(compareModelVersionsDesc("gpt-6-astra", "gpt-5.6-luna")).toBeLessThan(0);
      expect(compareModelVersionsDesc("gpt-5.6-luna", "gpt-5.4-mini")).toBeLessThan(0);
      expect(compareModelVersionsDesc("deepseek-v4.1-flash", "deepseek-v4-flash")).toBeLessThan(0);
      expect(compareModelVersionsDesc("kimi-k3", "kimi-k2.6")).toBeLessThan(0);
      expect(compareModelVersionsDesc("gemini-3.8-flash", "gemini-3.7-flash")).toBeLessThan(0);
      expect(compareModelVersionsDesc("grok-4.7", "grok-4.6")).toBeLessThan(0);
      expect(compareModelVersionsDesc("muse-spark-1.3", "muse-spark-1.2")).toBeLessThan(0);
    });
  });

  describe("Model Categorization into 4 Categories", () => {
    it("correctly separates models into Free, Frontier, Chinese, Others", () => {
      const sample = [
        "big-pickle",
        "nemotron-3.5-lightning-free",
        "muse-spark-1.3-contributor-free",
        "claude-opus-5",
        "claude-sonnet-4-6",
        "gpt-6-astra",
        "gpt-5.4-mini",
        "gemini-3.8-flash",
        "grok-4.7",
        "muse-spark-1.3",
        "deepseek-v4.1-flash",
        "kimi-k3",
        "glm-5.3",
        "qwen3.8-flash",
        "minimax-m3",
        "longcat-2.0",
        "omen-alpha",
        "test-ignored",
      ];

      const cats = categorizeOpenCodeModels(sample);

      // Free: Big Pickle, Nemotron, Free Muse Spark
      expect(cats.free).toEqual([
        "muse-spark-1.3-contributor-free",
        "big-pickle",
        "nemotron-3.5-lightning-free",
      ]);

      // Frontier: Opus 5 > Sonnet 4-6 > GPT-6 > GPT-5.4 > Gemini 3.8 > Grok 4.7 (xAI) > Muse Spark 1.3 (Meta)
      expect(cats.frontier).toEqual([
        "claude-opus-5",
        "claude-sonnet-4-6",
        "gpt-6-astra",
        "gpt-5.4-mini",
        "gemini-3.8-flash",
        "grok-4.7",
        "muse-spark-1.3",
      ]);

      // Chinese: DeepSeek v4.1 > Kimi k3 > GLM 5.3 > Qwen 3.8 > MiniMax m3
      expect(cats.chinese).toEqual([
        "deepseek-v4.1-flash",
        "kimi-k3",
        "glm-5.3",
        "qwen3.8-flash",
        "minimax-m3",
      ]);

      // Others: Longcat 2.0, Omen Alpha
      expect(cats.others).toEqual(["longcat-2.0", "omen-alpha"]);

      // test models excluded
      expect(cats.others).not.toContain("test-ignored");
    });

    it("covers ALL 88 live OpenCode catalog models with zero unclassified or duplicates", () => {
      const cats = categorizeOpenCodeModels(ALL_88_OPENCODE_MODELS);

      expect(cats.free.length).toBe(13);
      expect(cats.frontier.length).toBe(47);
      expect(cats.chinese.length).toBe(25);
      expect(cats.others.length).toBe(3);

      const totalCount =
        cats.free.length + cats.frontier.length + cats.chinese.length + cats.others.length;
      expect(totalCount).toBe(88);

      // Verify no duplicates across categories
      const combined = [
        ...cats.free,
        ...cats.frontier,
        ...cats.chinese,
        ...cats.others,
      ];
      const unique = new Set(combined);
      expect(unique.size).toBe(88);

      // Verify every original model is present
      for (const m of ALL_88_OPENCODE_MODELS) {
        expect(unique.has(m)).toBe(true);
      }
    });

    it("properly sorts models descending by version within Frontier", () => {
      const cats = categorizeOpenCodeModels(ALL_88_OPENCODE_MODELS);
      const frontier = cats.frontier;

      // Opus versions are descending
      const opus5Idx = frontier.indexOf("claude-opus-5");
      const opus48Idx = frontier.indexOf("claude-opus-4-8");
      const opus47Idx = frontier.indexOf("claude-opus-4-7");
      const opus45Idx = frontier.indexOf("claude-opus-4-5");
      expect(opus5Idx).toBeLessThan(opus48Idx);
      expect(opus48Idx).toBeLessThan(opus47Idx);
      expect(opus47Idx).toBeLessThan(opus45Idx);

      // Sonnet versions are descending
      const sonnet5Idx = frontier.indexOf("claude-sonnet-5");
      const sonnet46Idx = frontier.indexOf("claude-sonnet-4-6");
      const sonnet45Idx = frontier.indexOf("claude-sonnet-4-5");
      expect(sonnet5Idx).toBeLessThan(sonnet46Idx);
      expect(sonnet46Idx).toBeLessThan(sonnet45Idx);

      // GPT versions: GPT-6 before GPT-5.6 before GPT-5.4 before GPT-5
      const gpt6Idx = frontier.indexOf("gpt-6-astra");
      const gpt56Idx = frontier.indexOf("gpt-5.6-luna");
      const gpt54Idx = frontier.indexOf("gpt-5.4");
      const gpt5Idx = frontier.indexOf("gpt-5");
      expect(gpt6Idx).toBeLessThan(gpt56Idx);
      expect(gpt56Idx).toBeLessThan(gpt54Idx);
      expect(gpt54Idx).toBeLessThan(gpt5Idx);

      // Gemini versions: 3.8 before 3.7 before 3.5 before 3
      const gemini38Idx = frontier.indexOf("gemini-3.8-flash");
      const gemini37Idx = frontier.indexOf("gemini-3.7-flash");
      const gemini35Idx = frontier.indexOf("gemini-3.5-flash");
      const gemini3Idx = frontier.indexOf("gemini-3-flash");
      expect(gemini38Idx).toBeLessThan(gemini37Idx);
      expect(gemini37Idx).toBeLessThan(gemini35Idx);
      expect(gemini35Idx).toBeLessThan(gemini3Idx);

      // Grok (xAI) versions in Frontier: 4.7 before 4.6 before 4.5 before build-0.1
      const g47Idx = frontier.indexOf("grok-4.7");
      const g46Idx = frontier.indexOf("grok-4.6");
      const g45Idx = frontier.indexOf("grok-4.5");
      const g01Idx = frontier.indexOf("grok-build-0.1");
      expect(g47Idx).toBeLessThan(g46Idx);
      expect(g46Idx).toBeLessThan(g45Idx);
      expect(g45Idx).toBeLessThan(g01Idx);

      // Paid Muse Spark (Meta) in Frontier: 1.3 before 1.2
      const muse13Idx = frontier.indexOf("muse-spark-1.3");
      const muse12Idx = frontier.indexOf("muse-spark-1.2");
      expect(muse13Idx).toBeLessThan(muse12Idx);
    });

    it("properly sorts models descending by version within Chinese", () => {
      const cats = categorizeOpenCodeModels(ALL_88_OPENCODE_MODELS);
      const chinese = cats.chinese;

      // DeepSeek: v4.1 before v4-flash before deepseek-flash
      const ds41Idx = chinese.indexOf("deepseek-v4.1-flash");
      const ds4Idx = chinese.indexOf("deepseek-v4-flash");
      const dsFlashIdx = chinese.indexOf("deepseek-flash");
      expect(ds41Idx).toBeLessThan(ds4Idx);
      expect(ds4Idx).toBeLessThan(dsFlashIdx);

      // Kimi: k3 before k2.7 before k2.6 before k2.5
      const k3Idx = chinese.indexOf("kimi-k3");
      const k27Idx = chinese.indexOf("kimi-k2.7-code");
      const k26Idx = chinese.indexOf("kimi-k2.6");
      const k25Idx = chinese.indexOf("kimi-k2.5");
      expect(k3Idx).toBeLessThan(k27Idx);
      expect(k27Idx).toBeLessThan(k26Idx);
      expect(k26Idx).toBeLessThan(k25Idx);

      // GLM: 5.3 before 5.2 before 5.1 before 5
      const glm53Idx = chinese.indexOf("glm-5.3");
      const glm52Idx = chinese.indexOf("glm-5.2");
      const glm51Idx = chinese.indexOf("glm-5.1");
      const glm5Idx = chinese.indexOf("glm-5");
      expect(glm53Idx).toBeLessThan(glm52Idx);
      expect(glm52Idx).toBeLessThan(glm51Idx);
      expect(glm51Idx).toBeLessThan(glm5Idx);

      // Qwen: 3.8 before 3.7 before 3.6 before 3.5
      const qwen38Idx = chinese.indexOf("qwen3.8-max");
      const qwen37Idx = chinese.indexOf("qwen3.7-max");
      const qwen36Idx = chinese.indexOf("qwen3.6-plus");
      const qwen35Idx = chinese.indexOf("qwen3.5-plus");
      expect(qwen38Idx).toBeLessThan(qwen37Idx);
      expect(qwen37Idx).toBeLessThan(qwen36Idx);
      expect(qwen36Idx).toBeLessThan(qwen35Idx);

      // MiniMax: m3 before m2.7 before m2.5
      const mm3Idx = chinese.indexOf("minimax-m3");
      const mm27Idx = chinese.indexOf("minimax-m2.7");
      const mm25Idx = chinese.indexOf("minimax-m2.5");
      expect(mm3Idx).toBeLessThan(mm27Idx);
      expect(mm27Idx).toBeLessThan(mm25Idx);
    });

    it("properly sorts models descending by version within Others", () => {
      const cats = categorizeOpenCodeModels(ALL_88_OPENCODE_MODELS);
      const others = cats.others;

      expect(others).toEqual(["longcat-2.0", "omen-alpha", "jev-1.13"]);
    });

    it("properly sorts models within Free", () => {
      const cats = categorizeOpenCodeModels(ALL_88_OPENCODE_MODELS);
      const free = cats.free;

      // Free Muse Spark: 1.3 before 1.2
      const muse13Idx = free.indexOf("muse-spark-1.3-contributor-free");
      const muse12Idx = free.indexOf("muse-spark-1.2-contributor-free");
      expect(muse13Idx).toBeLessThan(muse12Idx);

      // Nemotron: 3.5 before 3
      const nemo35Idx = free.indexOf("nemotron-3.5-lightning-free");
      const nemo3Idx = free.indexOf("nemotron-3-ultra-free");
      expect(nemo35Idx).toBeLessThan(nemo3Idx);

      // Mimo: 2.6 before 2.5
      const mimo26Idx = free.indexOf("mimo-v2.6-flash");
      const mimo25Idx = free.indexOf("mimo-v2.5");
      expect(mimo26Idx).toBeLessThan(mimo25Idx);
    });
  });

  describe("setupOpenCodeInteractive with Four Categories", () => {
    it("should present the four categories in order: Free, Frontier, Chinese, Others", async () => {
      storeOpenCodeApiKey("sk-opencode-test-key");

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const u = url.toString();
        if (u.includes("zen/v1/models")) {
          return new Response(
            JSON.stringify({
              data: [
                { id: "big-pickle" },
                { id: "claude-sonnet-5" },
                { id: "kimi-k3" },
                { id: "longcat-2.0" },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      let categoryChoicesCaptured: string[] = [];
      vi.spyOn(ui, "select").mockImplementation(async (prompt, choices) => {
        if (prompt.includes("category")) {
          categoryChoicesCaptured = choices as string[];
          // Pick category 1: Frontier
          return { index: 1, value: choices[1] };
        }
        // Pick model inside Frontier: claude-sonnet-5
        return { index: 0, value: "claude-sonnet-5" };
      });

      const res = await setupOpenCodeInteractive();
      expect(res.model).toBe("claude-sonnet-5");
      expect(res.apiKey).toBe("sk-opencode-test-key");

      // Verify the 4 categories were presented in exact order
      expect(categoryChoicesCaptured.length).toBe(4);
      expect(categoryChoicesCaptured[0]).toContain("Free");
      expect(categoryChoicesCaptured[1]).toContain("Frontier");
      expect(categoryChoicesCaptured[2]).toContain("Chinese");
      expect(categoryChoicesCaptured[3]).toContain("Others");
    });

    it("should allow picking a model from Chinese category", async () => {
      storeOpenCodeApiKey("sk-opencode-test-key");

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const u = url.toString();
        if (u.includes("zen/v1/models")) {
          return new Response(
            JSON.stringify({
              data: [
                { id: "big-pickle" },
                { id: "claude-opus-5" },
                { id: "deepseek-v4.1-flash" },
                { id: "longcat-2.0" },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      vi.spyOn(ui, "select").mockImplementation(async (prompt, choices) => {
        if (prompt.includes("category")) {
          // Index 2 is Chinese
          return { index: 2, value: choices[2] };
        }
        return { index: 0, value: "deepseek-v4.1-flash" };
      });

      const res = await setupOpenCodeInteractive();
      expect(res.model).toBe("deepseek-v4.1-flash");
    });

    it("should allow picking Grok or Muse Spark from Frontier category", async () => {
      storeOpenCodeApiKey("sk-opencode-test-key");

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const u = url.toString();
        if (u.includes("zen/v1/models")) {
          return new Response(
            JSON.stringify({
              data: [
                { id: "big-pickle" },
                { id: "grok-4.7" },
                { id: "muse-spark-1.3" },
                { id: "deepseek-v4.1-flash" },
                { id: "longcat-2.0" },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      let frontierChoices: string[] = [];
      vi.spyOn(ui, "select").mockImplementation(async (prompt, choices) => {
        if (prompt.includes("category")) {
          // Index 1 is Frontier
          return { index: 1, value: choices[1] };
        }
        frontierChoices = choices as string[];
        return { index: 0, value: "grok-4.7" };
      });

      const res = await setupOpenCodeInteractive();
      expect(res.model).toBe("grok-4.7");
      expect(frontierChoices).toContain("grok-4.7");
      expect(frontierChoices).toContain("muse-spark-1.3");
    });

    it("should fall back to manual model input when no models are returned", async () => {
      storeOpenCodeApiKey("sk-opencode-test-key");

      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      vi.spyOn(ui, "input").mockResolvedValueOnce("gpt-5.4-mini");

      const res = await setupOpenCodeInteractive();
      expect(res.model).toBe("gpt-5.4-mini");
    });
  });
});
