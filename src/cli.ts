#!/usr/bin/env node

/**
 * Pontis CLI — interactive bridge between OpenCode/Local models and AI harnesses
 */

import { Command } from "commander";
import { spawn, execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  createWriteStream,
  statSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

import pkg from "../package.json";

const __CLI_DIR = dirname(fileURLToPath(import.meta.url));
// In dev mode (tsx running src/cli.ts), ROOT is the project root (parent of src/).
// In installed/bundled mode (node running dist/cli.js or ~/.local/bin/cli.js), ROOT is the script's own directory.
const ROOT = existsSync(join(dirname(__CLI_DIR), "package.json"))
  ? dirname(__CLI_DIR)
  : __CLI_DIR;

function getVersion(): string {
  return pkg.version || "0.0.0";
}

const VERSION = getVersion();

const t = {
  primary: chalk.hex("#A78BFA"), // lilac — brand, headings
  secondary: chalk.hex("#22D3EE"), // cyan — secondary info
  success: chalk.hex("#4ADE80"), // green — success states
  warning: chalk.hex("#FBBF24"), // amber — warnings
  error: chalk.hex("#F87171"), // red — errors
  muted: chalk.hex("#64748B"), // slate-500 — subtitles
  dim: chalk.dim,
  bold: chalk.bold,
  accent: chalk.hex("#E2E8F0"), // slate-200 — body text
};

// Symbols
const SYM = {
  bullet: "●",
  arrow: "▶",
  check: "✓",
  cross: "✗",
  warn: "⚠",
  dot: "·",
  diamond: "◆",
  separator: "━",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

// ══════════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════════

const PORT = 8787;
const PROXY_URL = `http://localhost:${PORT}`;
const KEY_FILE = join(homedir(), ".opencode_api_key");
const CACHE_FILE = join(homedir(), ".pontis_models_cache.json");
const DIST_PROXY = join(ROOT, "dist", "proxy.js");
const SRC_DIR = join(ROOT, "src");
const PONTIS_DIR = join(homedir(), ".pontis");
const PROXY_LOG = join(PONTIS_DIR, "proxy.log");
const FALLBACK_MODELS = [
  "mimo-v2.5-free",
  "deepseek-v4-flash-free",
  "big-pickle",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
];

// ══════════════════════════════════════════════════════════════
//  UI COMPONENTS
// ══════════════════════════════════════════════════════════════

/** Display the brand splash on startup */
function splash() {
  const divider = chalk.dim(SYM.separator.repeat(42));
  console.log(
    `\n  ${t.primary(SYM.diamond)}  ${t.bold("Pontis")}  ${t.muted(`v${VERSION}`)}`,
  );
  console.log(`  ${t.muted("Bridge AI models ↔ CLI harnesses")}`);
  console.log(`  ${chalk.dim(divider)}\n`);
}

/** Section header with title */
function section(title: string) {
  console.log(`\n  ${t.primary(SYM.bullet)}  ${t.bold(title)}`);
  console.log(
    `  ${t.muted(SYM.separator.repeat(Math.min(title.length + 4, 46)))}\n`,
  );
}

/** Status badge */
function badge(
  type: "success" | "warning" | "error" | "info" | "muted",
  text: string,
) {
  const colors = {
    success: t.success,
    warning: t.warning,
    error: t.error,
    info: t.secondary,
    muted: t.muted,
  };
  const syms = {
    success: SYM.check,
    warning: SYM.warn,
    error: SYM.cross,
    info: SYM.arrow,
    muted: SYM.dot,
  };
  console.log(`  ${colors[type](syms[type])}  ${text}`);
}

/** Inline status (same-line update) */
function statusLine(text: string, symbol = SYM.dot) {
  process.stdout.write(`\r  ${t.muted(symbol)}  ${text}`);
}

function clearLine() {
  process.stdout.write("\r\x1b[K");
}

/** Spinner for async operations */
function createSpinner(message: string) {
  let frame = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let isDone = false;

  function start() {
    statusLine(message, SYM.spinner[0]);
    interval = setInterval(() => {
      frame = (frame + 1) % SYM.spinner.length;
      if (!isDone) statusLine(message, SYM.spinner[frame]);
    }, 80);
    return spinner;
  }

  const spinner = {
    start,
    stop(result: { type: "success" | "warning" | "error"; text: string }) {
      isDone = true;
      if (interval) clearInterval(interval);
      clearLine();
      badge(result.type, result.text);
    },
    update(msg: string) {
      message = msg;
      if (!isDone) statusLine(message, SYM.spinner[frame]);
    },
  };

  return spinner.start();
}

/** Readline-based input prompt */
async function input(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` ${t.muted(`[${defaultValue}]`)}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${t.secondary("?")}  ${question}${suffix} `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

/** Confirm prompt (y/n) */
async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await input(`${question} ${t.muted(`(${hint})`)}`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

/** Numbered selection menu */
async function select<T extends string>(
  label: string,
  options: T[],
): Promise<{ value: T; index: number }> {
  console.log(`\n  ${t.secondary("?")}  ${label}\n`);
  for (let i = 0; i < options.length; i++) {
    console.log(`    ${t.primary(String(i + 1).padStart(2))}  ${options[i]}`);
  }
  const extra = options.length + 1;
  console.log(
    `    ${t.primary(String(extra).padStart(2))}  ${t.muted("Custom (enter manually)")}\n`,
  );

  while (true) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`  ${t.muted("Enter choice [1-" + extra + "]")} `, (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= extra) {
      if (num === extra) return { value: "" as T, index: -1 };
      return { value: options[num - 1], index: num - 1 };
    }
    console.log(`  ${t.warning("Please enter 1–" + extra)}`);
  }
}

/** Show a key-value pair */
function kv(key: string, value: string) {
  console.log(`  ${t.muted(key.padEnd(16))}  ${value}`);
}

// ══════════════════════════════════════════════════════════════
//  STRUCTURED OUTPUT (--json flag)
// ══════════════════════════════════════════════════════════════

/** Global flag: true when --json is passed anywhere in argv. */
const jsonMode = process.argv.includes("--json");

/** Output structured JSON and exit. */
function outputJson(data: Record<string, unknown>): never {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

/** Output a structured error and exit with code 1. */
function outputJsonError(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): never {
  console.log(
    JSON.stringify({ error: true, code, message, ...extra }, null, 2),
  );
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════
//  API KEY MANAGEMENT
// ══════════════════════════════════════════════════════════════

async function cmdUpdateKey(keyArg?: string) {
  splash();
  section("Update OpenCode API Key");
  let apiKey = keyArg;
  if (!apiKey) {
    console.log(
      `  ${t.muted("Get your key at https://opencode.ai/auth → Zen → API Keys")}\n`,
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

// ══════════════════════════════════════════════════════════════
//  LOCAL MODEL SETUP
// ══════════════════════════════════════════════════════════════

const LOCAL_ENGINES = [
  { name: "Ollama", url: "http://localhost:11434/v1" },
  { name: "LM Studio", url: "http://localhost:1234/v1" },
  { name: "Llama.cpp", url: "http://localhost:8080/v1" },
  { name: "Custom URL", url: "" },
];

async function selectLocalEngineInteractive(): Promise<string> {
  section("Pick Local Engine");
  for (let i = 0; i < LOCAL_ENGINES.length; i++) {
    console.log(
      `    ${t.primary(String(i + 1).padStart(2))}  ${LOCAL_ENGINES[i].name}  ${t.muted(LOCAL_ENGINES[i].url || "")}`,
    );
  }
  console.log();
  const opt = await input("Select engine", "1");
  const idx = parseInt(opt, 10);
  if (idx >= 1 && idx <= 3) return LOCAL_ENGINES[idx - 1].url;
  if (idx === 4) {
    const url = await input("Enter custom endpoint URL");
    if (!url) badge("error", "URL required.");
    return url;
  }
  return LOCAL_ENGINES[0].url;
}

function getLocalApiKey(): string {
  return (
    process.env.LOCAL_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "local-model-dummy-api-key-value-32-chars-long"
  );
}

async function fetchLocalModels(
  upstreamUrl: string,
  apiKey: string,
): Promise<string[]> {
  try {
    const res = await fetch(`${upstreamUrl}/models`, {
      headers:
        apiKey !== "local-model-dummy-api-key-value-32-chars-long"
          ? { Authorization: `Bearer ${apiKey}` }
          : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    if (!json || !Array.isArray(json.data)) return [];
    return json.data.map((m: any) => m.id);
  } catch {
    return [];
  }
}

async function setupLocalInteractive(): Promise<{
  model: string;
  upstreamUrl: string;
  upstreamFormat: string;
  apiKey: string;
}> {
  const upstreamUrl = await selectLocalEngineInteractive();
  const apiKey = getLocalApiKey();

  if (!process.env.PONTIS_UPSTREAM_URL)
    process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  if (!process.env.PONTIS_UPSTREAM_FORMAT)
    process.env.PONTIS_UPSTREAM_FORMAT = "openai";

  const spin = createSpinner("Scanning local models...");
  const models = await fetchLocalModels(upstreamUrl, apiKey);
  spin.stop(
    models.length > 0
      ? {
          type: "success",
          text: `Found ${models.length} model${models.length === 1 ? "" : "s"}`,
        }
      : { type: "warning", text: "No models returned from upstream" },
  );

  let model: string;
  if (models.length === 0) {
    console.log(
      `\n  ${t.warning(SYM.warn)}  Could not auto-detect. Enter a model name manually.\n`,
    );
    model = await input("Model name", "llama3");
    if (!model) model = "llama3";
  } else {
    const result = await select("Pick a model", models);
    if (result.index === -1) {
      model = await input("Enter model ID");
      if (!model) model = models[0];
    } else {
      model = result.value;
    }
  }

  return { model, upstreamUrl, upstreamFormat: "openai", apiKey };
}

// ══════════════════════════════════════════════════════════════
//  OPENCODE MODEL SETUP
// ══════════════════════════════════════════════════════════════

async function getOpenCodeApiKeyInteractive(): Promise<string> {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  if (existsSync(KEY_FILE)) {
    const saved = readFileSync(KEY_FILE, "utf-8").trim().replace(/\r/g, "");
    if (saved) return saved;
  }

  section("OpenCode API Key");
  console.log(
    `  ${t.muted("Get yours at https://opencode.ai/auth → Zen → API Keys")}\n`,
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

async function checkModelOnline(
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

async function fetchWorkingOpenCodeModels(apiKey: string): Promise<string[]> {
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

async function setupOpenCodeInteractive(): Promise<{
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
    if (!model) error("Model ID required.");
  } else {
    model = result.value;
  }

  return { model, apiKey };
}

// ══════════════════════════════════════════════════════════════
//  PROVIDER SELECTION (interactive)
// ══════════════════════════════════════════════════════════════

async function selectProviderInteractive(): Promise<"opencode" | "local"> {
  const result = await select("Choose your provider", [
    `${t.primary("OpenCode")}  ${t.muted("Free cloud models (Zen/Go)")}`,
    `${t.primary("Local")}     ${t.muted("Ollama, LM Studio, Llama.cpp…")}`,
  ]);
  return result.index === 1 ? "local" : "opencode";
}

// ══════════════════════════════════════════════════════════════
//  CLIENT SELECTION (interactive)
// ══════════════════════════════════════════════════════════════

async function selectClientInteractive(): Promise<string> {
  const result = await select("Launch which client?", [
    `${t.primary("Claude Code")}  ${t.muted("Anthropic's AI coding assistant")}`,
    `${t.primary("Codex")}    ${t.muted("OpenAI's terminal coding agent")}`,
    `${t.primary("Server")}   ${t.muted("Run proxy server only (no client launcher)")}`,
  ]);
  if (result.index === 1) return "codex";
  if (result.index === 2) return "server";
  return "claude";
}

// ══════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════════

/** Tracked proxy PID so SIGINT/SIGTERM can clean it up. */
let activeProxy: { pid: number } | null = null;

/** Register a one-shot shutdown handler. */
function onShutdown(handler: () => void) {
  const done = () => {
    handler();
    process.exit(0);
  };
  process.on("SIGINT", done);
  process.on("SIGTERM", done);
}

// ══════════════════════════════════════════════════════════════
//  PROXY MANAGEMENT
// ══════════════════════════════════════════════════════════════

function needsProxyRebuild(): boolean {
  if (!existsSync(DIST_PROXY)) return true;
  try {
    const distMtime = statSync(DIST_PROXY).mtimeMs;
    const entries = readdirSync(SRC_DIR, { recursive: true });
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : String(entry);
      if (name.endsWith(".ts")) {
        if (statSync(join(SRC_DIR, name)).mtimeMs > distMtime) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function buildProxy() {
  const spin = createSpinner("Building proxy bundle...");
  try {
    if (!existsSync(join(ROOT, "node_modules"))) {
      spin.update("Installing dependencies...");
      execSync("npm install --silent", { cwd: ROOT, stdio: "ignore" });
    }
    spin.update("Compiling TypeScript...");
    execSync("npm run build:proxy", { cwd: ROOT, stdio: "ignore" });
    spin.stop({ type: "success", text: "Proxy bundle ready" });
  } catch {
    spin.stop({ type: "warning", text: "Using tsx source mode (no build)" });
  }
}

function findNativeBinary(): string | null {
  // Search order: project layout paths, then sibling of the CLI script (installed layout).
  for (const p of [
    join(ROOT, "bin", "pontis-proxy"),
    join(ROOT, "pontis-proxy"),
    join(__CLI_DIR, "pontis-proxy"),
  ]) {
    if (existsSync(p)) return p;
  }
  // In installed mode only (no source tree), check if pontis-proxy is on PATH.
  // Skip this in dev mode to avoid shadowing the local dist/proxy.js with a
  // stale system-wide binary.
  if (!existsSync(SRC_DIR)) {
    try {
      const resolved = execSync("which pontis-proxy 2>/dev/null || true")
        .toString()
        .trim();
      if (resolved && existsSync(resolved)) return resolved;
    } catch {}
  }
  return null;
}

async function startProxy(model: string, codexMode: boolean): Promise<number> {
  // Kill existing proxy
  try {
    const existing = execSync(`lsof -t -i :${PORT} 2>/dev/null || true`)
      .toString()
      .trim();
    // Validate output contains only PIDs (digits) to prevent command injection
    if (existing && /^\d+(\s+\d+)*$/.test(existing)) {
      for (const pid of existing.split(/\s+/)) {
        try {
          process.kill(parseInt(pid, 10), 9);
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {}

  if (codexMode) process.env.PONTIS_CODEX_MODE = "true";
  // Skip key-length check for local providers (Ollama/LM Studio keys are often short)
  if (!codexMode && process.env.PONTIS_PROVIDER === "local") {
    process.env.PONTIS_MIN_KEY_LENGTH = "0";
  }

  // Build if needed
  if (needsProxyRebuild()) buildProxy();

  const env = { ...process.env, PONTIS_MODEL: model };
  const nativeBin = findNativeBinary();
  let child;

  const spin = createSpinner("Starting Pontis proxy...");

  if (nativeBin) {
    execSync(`chmod +x "${nativeBin}"`, { stdio: "ignore" });
    child = spawn(nativeBin, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  } else if (existsSync(DIST_PROXY)) {
    child = spawn("node", [DIST_PROXY], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    if (!existsSync(join(ROOT, "node_modules"))) {
      spin.update("Installing dependencies...");
      execSync("npm install --silent", { cwd: ROOT, stdio: "ignore" });
    }
    child = spawn(
      "npx",
      ["--no-install", "tsx", join(SRC_DIR, "local-server.ts")],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  if (!existsSync(PONTIS_DIR))
    mkdirSync(PONTIS_DIR, { mode: 0o700, recursive: true });
  const logStream = createWriteStream(PROXY_LOG, { flags: "a", mode: 0o600 });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  // Wait for ready
  let attempts = 0;
  while (true) {
    attempts++;
    try {
      const res = await fetch(PROXY_URL + "/");
      if (res.ok) break;
    } catch {}
    if (attempts >= 120) {
      spin.stop({
        type: "error",
        text: `Proxy failed to start on port ${PORT} (check ${PROXY_LOG})`,
      });
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Track for graceful shutdown
  activeProxy = { pid: child.pid! };
  onShutdown(() => {
    try {
      process.kill(activeProxy!.pid, "SIGTERM");
    } catch {}
  });

  spin.stop({
    type: "success",
    text: `Proxy running on ${t.secondary(PROXY_URL)}`,
  });
  return child.pid!;
}

// ══════════════════════════════════════════════════════════════
//  CONNECTIVITY TEST
// ══════════════════════════════════════════════════════════════

async function testConnectivity(
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

// ══════════════════════════════════════════════════════════════
//  CLIENT LAUNCH
// ══════════════════════════════════════════════════════════════

function autoApproveClaudeKey(apiKey: string) {
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

function launchClient(
  clientCmd: string,
  model: string,
  apiKey: string,
  extraArgs: string[],
): Promise<void> {
  section(
    "Launching " +
      (clientCmd === "codex"
        ? "Codex"
        : clientCmd === "server"
          ? "Server Mode"
          : "Claude Code"),
  );

  kv("Proxy", t.secondary(PROXY_URL));
  kv("Model", t.primary(model));
  if (extraArgs.length > 0) kv("Args", t.muted(extraArgs.join(" ")));
  console.log();

  if (clientCmd === "server") {
    badge("info", "Proxy is live — connect your clients");
    console.log(`  ${t.muted("Press Ctrl+C to stop\n")}`);
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

function warn(msg: string) {
  console.log(`  ${t.warning(SYM.warn)}  ${msg}`);
}
function error(msg: string): never {
  console.log(`\n  ${t.error(SYM.cross)}  ${msg}\n`);
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════
//  INTERACTIVE WIZARD
// ══════════════════════════════════════════════════════════════

interface PontisEnv {
  clientCmd?: string;
  model?: string;
  provider?: "opencode" | "local";
  apiKey?: string;
  upstreamUrl?: string;
  upstreamFormat?: string;
}

async function runInteractiveWizard(env: PontisEnv) {
  splash();

  // Step 1: Provider
  const provider = env.provider || (await selectProviderInteractive());

  // Step 2: API key + Model
  let model: string;
  let apiKey: string;

  section(provider === "local" ? "Local Setup" : "OpenCode Setup");

  if (provider === "local") {
    const local = await setupLocalInteractive();
    model = env.model || local.model;
    apiKey = env.apiKey || local.apiKey;
  } else {
    const oc = await setupOpenCodeInteractive();
    model = env.model || oc.model;
    apiKey = env.apiKey || oc.apiKey;
  }

  // Step 3: Pick client
  const clientCmd = env.clientCmd || (await selectClientInteractive());

  // Step 4: Start proxy
  section("Infrastructure");
  badge("muted", `Model: ${t.primary(model)}`);

  try {
    await startProxy(model, clientCmd === "codex");

    // Step 5: Connectivity
    const ok = await testConnectivity(apiKey, model);
    if (!ok) {
      process.exit(1);
    }

    // Step 6: Launch
    await launchClient(clientCmd, model, apiKey, []);
  } finally {
    if (activeProxy) {
      try {
        process.kill(activeProxy.pid, "SIGTERM");
      } catch {}
      activeProxy = null;
    }
    // Remove our shutdown handlers so they don't fire during normal exit
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
}

// ══════════════════════════════════════════════════════════════
//  SUBCOMMAND RUNNER — interactive fallback for missing config
// ══════════════════════════════════════════════════════════════

async function runWithConfig(
  clientCmd: string,
  opts: Record<string, any>,
  extraArgs: string[],
) {
  splash();

  const provider: "opencode" | "local" =
    opts.provider ||
    (process.env.PONTIS_PROVIDER as "opencode" | "local") ||
    (process.env.PONTIS_UPSTREAM_URL ? "local" : "opencode");
  let upstreamUrl = opts.upstream || process.env.PONTIS_UPSTREAM_URL;
  const upstreamFormat = opts.format || process.env.PONTIS_UPSTREAM_FORMAT;
  const modelFromOptsEnv = opts.model || process.env.PONTIS_MODEL;
  let apiKey =
    opts.apiKey ||
    (provider === "local" ? getLocalApiKey() : process.env.OPENCODE_API_KEY);
  let model = modelFromOptsEnv || FALLBACK_MODELS[0];

  if (upstreamUrl) process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
  if (upstreamFormat) process.env.PONTIS_UPSTREAM_FORMAT = upstreamFormat;
  process.env.PONTIS_PROVIDER = provider;

  // When API key or model isn't from opts/env, fall back to interactive for the missing bits
  const hasModel = !!modelFromOptsEnv;
  const hasApiKey = !!opts.apiKey;

  if (!hasApiKey || !hasModel) {
    if (provider === "local") {
      if (!upstreamUrl) {
        upstreamUrl = await selectLocalEngineInteractive();
        process.env.PONTIS_UPSTREAM_URL = upstreamUrl;
      }
      // Avoid re-prompting for API key if flag/env already provided it
      if (opts.apiKey) process.env.LOCAL_API_KEY = opts.apiKey;
      apiKey = getLocalApiKey();
      const local = await setupLocalInteractive();
      model = hasModel ? model : local.model;
      apiKey = apiKey || local.apiKey;
    } else {
      // Avoid re-prompting for API key if flag already provided it
      if (opts.apiKey) process.env.OPENCODE_API_KEY = opts.apiKey;
      apiKey = apiKey || process.env.OPENCODE_API_KEY;
      const oc = await setupOpenCodeInteractive();
      model = hasModel ? model : oc.model;
      apiKey = apiKey || oc.apiKey;
    }
  } else if (provider === "local" && !upstreamUrl) {
    error("Upstream URL required. Use --upstream or PONTIS_UPSTREAM_URL.");
  }

  if (!apiKey) error("API key required.");
  if (!model) error("Model required.");

  section("Configuration");
  kv(
    "Mode",
    clientCmd === "codex"
      ? "Codex"
      : clientCmd === "server"
        ? "Server"
        : "Claude Code",
  );
  kv("Provider", provider === "local" ? "Local" : "OpenCode");
  kv("Model", t.primary(model));
  if (upstreamUrl) kv("Upstream", t.muted(upstreamUrl));
  console.log();

  try {
    await startProxy(model, clientCmd === "codex");
    const ok = await testConnectivity(apiKey, model);
    if (!ok) process.exit(1);
    await launchClient(clientCmd, model, apiKey, extraArgs);
  } finally {
    if (activeProxy) {
      try {
        process.kill(activeProxy.pid, "SIGTERM");
      } catch {}
      activeProxy = null;
    }
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
}

// ══════════════════════════════════════════════════════════════
//  COMMANDER SETUP
// ══════════════════════════════════════════════════════════════

const program = new Command();

program
  .name("pontis")
  .version(VERSION)
  .description(
    "Translation proxy bridging Anthropic/OpenAI formats to run Claude Code, Codex, and local models",
  )
  .option("--json", "Output in JSON format (for scripting)");

function addPontisOptions(cmd: Command) {
  return cmd
    .option("-m, --model <name>", "Model ID (e.g. mimo-v2.5-free)")
    .option("-p, --provider <type>", "Provider: opencode | local")
    .option("-k, --api-key <key>", "API key for the provider")
    .option("-u, --upstream <url>", "Upstream endpoint URL")
    .option(
      "-f, --format <format>",
      "Upstream format (openai | anthropic | openai-completions)",
    );
}

// Subcommand: claude
addPontisOptions(
  program
    .command("claude")
    .description("Start proxy and launch Claude Code with a configured model")
    .allowUnknownOption(true)
    .allowExcessArguments(true),
).action((opts) => {
  runWithConfig("claude", opts, extractChildArgs("claude")).catch((e) => {
    console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
    process.exit(1);
  });
});

// Subcommand: codex
addPontisOptions(
  program
    .command("codex")
    .description("Start proxy and launch Codex with a configured model")
    .allowUnknownOption(true)
    .allowExcessArguments(true),
).action((opts) => {
  runWithConfig("codex", opts, extractChildArgs("codex")).catch((e) => {
    console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
    process.exit(1);
  });
});

// Subcommand: server
addPontisOptions(
  program
    .command("server")
    .description("Start the proxy server without launching a client"),
).action((opts) => {
  runWithConfig("server", opts, []).catch((e) => {
    console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
    process.exit(1);
  });
});

// Subcommand: update-key
program
  .command("update-key")
  .description("Save a new OpenCode API key")
  .argument("[key]", "New API key (prompts if omitted)")
  .action((key) => {
    cmdUpdateKey(key).catch((e) => {
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    });
  });

// Subcommand: models — list available models
program
  .command("models")
  .description("List available models from the configured provider")
  .option("-p, --provider <type>", "Provider: opencode | local")
  .option("-u, --upstream <url>", "Upstream endpoint URL")
  .action(async (opts) => {
    try {
      const provider: "opencode" | "local" =
        opts.provider ||
        (process.env.PONTIS_PROVIDER as "opencode" | "local") ||
        (process.env.PONTIS_UPSTREAM_URL ? "local" : "opencode");

      let upstreamUrl = opts.upstream || process.env.PONTIS_UPSTREAM_URL;

      if (provider === "opencode") {
        const apiKey =
          process.env.OPENCODE_API_KEY ||
          (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf-8").trim() : "");
        if (!apiKey) {
          if (jsonMode)
            outputJsonError(
              "missing_api_key",
              "No OpenCode API key found. Set OPENCODE_API_KEY or run: pontis update-key",
            );
          badge(
            "error",
            "No OpenCode API key found. Set OPENCODE_API_KEY or run: pontis update-key",
          );
          process.exit(1);
        }
        const spin = jsonMode
          ? null
          : createSpinner("Fetching models from OpenCode...");
        const models = await fetchWorkingOpenCodeModels(apiKey);
        if (spin)
          spin.stop(
            models.length > 0
              ? {
                  type: "success",
                  text: `Found ${models.length} model${models.length === 1 ? "" : "s"}`,
                }
              : { type: "warning", text: "No models found" },
          );
        if (jsonMode) {
          outputJson({
            provider: "opencode",
            models: models.map((id) => ({ id })),
          });
        }
        if (models.length === 0) {
          badge("warning", "No models found. Check your API key.");
        } else {
          section("Available Models");
          for (const m of models) kv("Model", t.primary(m));
        }
      } else {
        if (!upstreamUrl) {
          if (jsonMode)
            outputJsonError(
              "missing_upstream",
              "Set --upstream or PONTIS_UPSTREAM_URL for local provider",
            );
          badge(
            "error",
            "Set --upstream or PONTIS_UPSTREAM_URL for local provider",
          );
          process.exit(1);
        }
        const apiKey =
          process.env.LOCAL_API_KEY || process.env.OPENAI_API_KEY || "";
        const spin = jsonMode
          ? null
          : createSpinner(`Scanning models at ${upstreamUrl}...`);
        const models = await fetchLocalModels(upstreamUrl, apiKey);
        if (spin)
          spin.stop(
            models.length > 0
              ? {
                  type: "success",
                  text: `Found ${models.length} model${models.length === 1 ? "" : "s"}`,
                }
              : { type: "warning", text: "No models returned from upstream" },
          );
        if (jsonMode) {
          outputJson({
            provider: "local",
            upstream: upstreamUrl,
            models: models.map((id) => ({ id })),
          });
        }
        if (models.length === 0) {
          badge("warning", "No models returned from upstream. Is it running?");
        } else {
          section("Available Models");
          for (const m of models) kv("Model", t.primary(m));
        }
      }
    } catch (e: any) {
      if (jsonMode) outputJsonError("fetch_failed", e.message || String(e));
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    }
  });

// Subcommand: status — show proxy and configuration status
program
  .command("status")
  .description("Show current proxy and configuration status")
  .action(async () => {
    try {
      let proxyRunning = false;
      let proxyPort = PORT;

      // Check if proxy is running by hitting the root endpoint
      try {
        const res = await fetch(PROXY_URL + "/", {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) proxyRunning = true;
      } catch {}

      const provider: string =
        process.env.PONTIS_PROVIDER ||
        (process.env.PONTIS_UPSTREAM_URL ? "local" : "opencode");
      const model = process.env.PONTIS_MODEL || FALLBACK_MODELS[0];
      const upstream =
        process.env.PONTIS_UPSTREAM_URL || "(default OpenCode Zen)";
      const format = process.env.PONTIS_UPSTREAM_FORMAT || "openai";
      const debug = process.env.PONTIS_DEBUG === "true";
      const keyExists = existsSync(KEY_FILE);

      if (jsonMode) {
        outputJson({
          proxy: { running: proxyRunning, port: proxyPort, url: PROXY_URL },
          provider,
          model,
          upstream,
          format,
          debug,
          apiKeySaved: keyExists,
          logs: PROXY_LOG,
        });
      }

      section("Pontis Status");

      if (proxyRunning) {
        badge("success", `Proxy running on ${t.secondary(PROXY_URL)}`);
      } else {
        badge(
          "warning",
          `Proxy not running (start with: ${t.secondary("pontis server")})`,
        );
      }

      console.log();
      section("Configuration");
      kv("Provider", t.primary(provider));
      kv("Model", t.primary(model));
      kv("Upstream", t.muted(upstream));
      kv("Format", format);
      kv("Debug", debug ? t.success("on") : t.muted("off"));
      kv("API Key", keyExists ? t.success("saved") : t.warning("not found"));
      kv("Logs", t.muted(PROXY_LOG));
      console.log();
    } catch (e: any) {
      if (jsonMode) outputJsonError("status_failed", e.message || String(e));
      console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
      process.exit(1);
    }
  });

// Default (no subcommand): interactive wizard
program.action(() => {
  const opts = program.opts();
  const env: PontisEnv = {};
  if (opts.model || process.env.PONTIS_MODEL)
    env.model = opts.model || process.env.PONTIS_MODEL;
  if (opts.provider || process.env.PONTIS_PROVIDER)
    env.provider =
      opts.provider || (process.env.PONTIS_PROVIDER as "opencode" | "local");
  if (opts.apiKey) env.apiKey = opts.apiKey;

  runInteractiveWizard(env).catch((e) => {
    console.error(`\n  ${t.error(SYM.cross)}  ${e.message}\n`);
    process.exit(1);
  });
});

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

const KNOWN_PONTIS_FLAGS = new Set([
  "-m",
  "--model",
  "-p",
  "--provider",
  "-k",
  "--api-key",
  "-u",
  "--upstream",
  "-f",
  "--format",
  "--json",
]);

function extractChildArgs(subcommand: string): string[] {
  const args = process.argv.slice(2);
  const subIdx = args.indexOf(subcommand);
  if (subIdx < 0) return [];
  const result: string[] = [];
  for (let i = subIdx + 1; i < args.length; i++) {
    const arg = args[i];
    if (KNOWN_PONTIS_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg === "--") {
      result.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--version" || arg === "-V" || arg === "--help" || arg === "-h")
      continue;
    result.push(arg);
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════

program.parse(process.argv);
