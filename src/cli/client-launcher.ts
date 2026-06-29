import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { t, SYM, badge, kv, confirm, createSpinner, warn } from "./ui";
import { PROXY_URL } from "./proxy-manager";

export function autoApproveClaudeKey(apiKey: string) {
  try {
    const configFile = join(homedir(), ".claude.json");
    const keySuffix = apiKey.slice(-20);
    if (existsSync(configFile)) {
      const config = JSON.parse(readFileSync(configFile, "utf-8"));
      if (!config.customApiKeyResponses) config.customApiKeyResponses = {};
      if (!config.customApiKeyResponses.approved)
        config.customApiKeyResponses.approved = [];
      // Respect the user's decision — never override a rejected key
      if (
        Array.isArray(config.customApiKeyResponses.rejected) &&
        config.customApiKeyResponses.rejected.includes(keySuffix)
      ) {
        badge(
          "warning",
          "API key was previously rejected in Claude — skipping auto-approval",
        );
        return;
      }
      if (!config.customApiKeyResponses.approved.includes(keySuffix)) {
        config.customApiKeyResponses.approved.push(keySuffix);
        badge("muted", "Auto-approved Pontis API key in ~/.claude.json");
      }
      writeFileSync(configFile, JSON.stringify(config, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
    }
  } catch {}
}

export function launchClient(
  clientCmd: string,
  model: string,
  apiKey: string,
  extraArgs: string[],
): Promise<void> {
  // Section header
  console.log(
    `\n  ${t.primary(SYM.bullet)}  ${t.bold("Launching " + (clientCmd === "codex" ? "Codex" : clientCmd === "server" ? "Server Mode" : "Claude Code"))}`,
  );
  console.log(`  ${t.muted(SYM.separator.repeat(28))}\n`);

  kv("Proxy", t.secondary(PROXY_URL));
  kv("Model", t.primary(model));
  if (extraArgs.length > 0) kv("Args", t.muted(extraArgs.join(" ")));
  console.log();

  if (clientCmd === "server") {
    badge("info", "Proxy is live — connect your clients");
    console.log(`  Press Ctrl+C to stop\n`);
    return new Promise(() => {}); // hang
  }

  const childEnv: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;

  if (clientCmd === "codex") {
    childEnv.OPENAI_BASE_URL = `${PROXY_URL}/v1`;
    childEnv.OPENAI_API_KEY = apiKey;
    if (!extraArgs.includes("--model"))
      extraArgs = ["--model", model, ...extraArgs];
  } else {
    childEnv.ANTHROPIC_BASE_URL = `${PROXY_URL}/zen`;
    childEnv.ANTHROPIC_API_KEY = apiKey;
    childEnv.ANTHROPIC_MODEL = model;
    childEnv.ANTHROPIC_SMALL_FAST_MODEL = model;
    autoApproveClaudeKey(apiKey);
  }

  badge(
    "muted",
    `Spawning: ${t.accent(clientCmd)} ${t.muted(extraArgs.join(" "))}\n`,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(clientCmd, extraArgs, {
      env: childEnv,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null)
        warn(`${clientCmd} exited with code ${code}`);
      resolve();
    });
    child.on("error", reject);
  });
}

export async function testConnectivity(
  apiKey: string,
  model: string,
): Promise<boolean> {
  const spin = createSpinner("Verifying API connection...");
  try {
    const res = await fetch(`${PROXY_URL}/zen/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 200) {
      spin.stop({ type: "success", text: "API connected successfully" });
      return true;
    }
    if (res.status === 401) {
      spin.stop({
        type: "error",
        text: "API returned 401 — check your API key",
      });
      const body = await res.text();
      console.log(`  ${t.muted(body.slice(0, 200))}\n`);
      return await confirm("Continue anyway?", false);
    }
    spin.stop({ type: "warning", text: `HTTP ${res.status} — continuing` });
    return true;
  } catch {
    spin.stop({
      type: "warning",
      text: "Could not reach API — continuing anyway",
    });
    return true;
  }
}
