import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { select, input, confirm, createSpinner, badge, section, splash } from "./ui";
import { KEY_FILE, CACHE_FILE, FALLBACK_MODELS } from "./config";

export async function getOpenCodeApiKeyInteractive(): Promise<string> {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  if (existsSync(KEY_FILE)) {
    const saved = readFileSync(KEY_FILE, "utf-8").trim().replace(/\r/g, "");
    if (saved) return saved;
  }

  section("OpenCode API Key");
  console.log(
    `  Get yours at https://opencode.ai/auth → Zen → API Keys\n`,
  );
  const key = await input("Paste your API key");
  if (!key) {
    badge("error", "API key required.");
    process.exit(1);
  }
  const save = await confirm("Save this key for future use?", true);
  if (save) {
    writeFileSync(KEY_FILE, key.trim(), { encoding: "utf-8", mode: 0o600 });
    badge("success", "Key saved to " + KEY_FILE);
  }
  return key.trim();
}

export async function checkModelOnline(
  model: string,
  apiKey: string,
): Promise<boolean> {
  try {
    const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 200) {
      const data: any = await res.json();
      return !!(data && !data.error);
    }
  } catch {}
  return false;
}

export async function fetchWorkingOpenCodeModels(apiKey: string): Promise<string[]> {
  if (existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      if (
        Array.isArray(cache.models) &&
        typeof cache.timestamp === "number" &&
        Date.now() - cache.timestamp < 86400000
      ) {
        return cache.models;
      }
    } catch {}
  }
  try {
    const res = await fetch("https://opencode.ai/zen/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    if (!json || !Array.isArray(json.data)) return [];
    const candidates = json.data
      .map((m: any) => m.id)
      .filter(
        (id: string) =>
          (id.endsWith("-free") && id !== "minimax-m3-free") ||
          id === "big-pickle",
      );
    const results = await Promise.all(
      candidates.map((m: string) => checkModelOnline(m, apiKey)),
    );
    const working = results.filter(Boolean).map((_, i) => candidates[i]);
    if (working.length > 0) {
      writeFileSync(
        CACHE_FILE,
        JSON.stringify({ timestamp: Date.now(), models: working }),
        { encoding: "utf-8", mode: 0o600 },
      );
    }
    return working;
  } catch {
    return [];
  }
}

export async function setupOpenCodeInteractive(): Promise<{
  model: string;
  apiKey: string;
}> {
  const apiKey = await getOpenCodeApiKeyInteractive();

  const spin = createSpinner("Checking available free models...");
  let models = await fetchWorkingOpenCodeModels(apiKey);
  spin.stop(
    models.length > 0
      ? {
          type: "success",
          text: `${models.length} model${models.length === 1 ? "" : "s"} available`,
        }
      : { type: "warning", text: "Using fallback model list" },
  );
  if (models.length === 0) models = FALLBACK_MODELS;

  const result = await select("Pick a free model", models);
  let model: string;
  if (result.index === -1) {
    model = await input("Enter model ID");
    if (!model) {
      badge("error", "Model ID required.");
      process.exit(1);
    }
  } else {
    model = result.value;
  }

  return { model, apiKey };
}

export async function cmdUpdateKey(keyArg?: string) {
  splash();
  section("Update OpenCode API Key");
  let apiKey = keyArg;
  if (!apiKey) {
    console.log(
      `  Get your key at https://opencode.ai/auth → Zen → API Keys\n`,
    );
    apiKey = await input("Paste your OpenCode API key");
  }
  if (!apiKey) {
    badge("error", "API key is required.");
    process.exit(1);
  }
  writeFileSync(KEY_FILE, apiKey.trim(), { encoding: "utf-8", mode: 0o600 });
  badge("success", `Saved to ${KEY_FILE}`);
}
