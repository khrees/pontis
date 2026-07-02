import { createInterface } from "node:readline";
import chalk from "chalk";
import pkg from "../../package.json";

export const VERSION = pkg.version || "0.0.0";

export const t = {
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
export const SYM = {
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

/** Display the brand splash on startup */
export function splash() {
  const divider = chalk.dim(SYM.separator.repeat(42));
  console.log(
    `\n  ${t.primary(SYM.diamond)}  ${t.bold("Pontis")}  ${t.muted(`v${VERSION}`)}`,
  );
  console.log(`  ${t.muted("Bridge AI models ↔ CLI harnesses")}`);
  console.log(`  ${chalk.dim(divider)}\n`);
}

/** Section header with title */
export function section(title: string) {
  console.log(`\n  ${t.primary(SYM.bullet)}  ${t.bold(title)}`);
  console.log(
    `  ${t.muted(SYM.separator.repeat(Math.min(title.length + 4, 46)))}\n`,
  );
}

/** Status badge */
export function badge(
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
export function statusLine(text: string, symbol = SYM.dot) {
  process.stdout.write(`\r  ${t.muted(symbol)}  ${text}`);
}

export function clearLine() {
  process.stdout.write("\r\x1b[K");
}

export async function selectProviderInteractive(): Promise<"opencode" | "local" | "cloudflare"> {
  const result = await select("Choose your provider", [
    `${t.primary("OpenCode")}     ${t.muted("Free cloud models (Zen/Go)")}`,
    `${t.primary("Cloudflare")}   ${t.muted("Workers AI via AI Gateway")}`,
    `${t.primary("Local")}        ${t.muted("Ollama, LM Studio, Llama.cpp…")}`,
  ]);
  if (result.index === 1) return "cloudflare";
  if (result.index === 2) return "local";
  return "opencode";
}

export async function selectClientInteractive(): Promise<string> {
  const result = await select("Launch which client?", [
    `${t.primary("Claude Code")}  ${t.muted("Anthropic's AI coding assistant")}`,
    `${t.primary("Codex")}    ${t.muted("OpenAI's terminal coding agent")}`,
    `${t.primary("Pi")}      ${t.muted("The Pi coding agent (pi.dev)")}`,
    `${t.primary("Server")}   ${t.muted("Run proxy server only (no client launcher)")}`,
  ]);
  if (result.index === 1) return "codex";
  if (result.index === 2) return "pi";
  if (result.index === 3) return "server";
  return "claude";
}

/** Spinner for async operations */
export function createSpinner(message: string) {
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
export async function input(question: string, defaultValue?: string): Promise<string> {
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
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await input(`${question} ${t.muted(`(${hint})`)}`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

/** Numbered selection menu */
export async function select<T extends string>(
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
export function kv(key: string, value: string) {
  console.log(`  ${t.muted(key.padEnd(16))}  ${value}`);
}

/** Global flag: true when --json is passed anywhere in argv. */
export const jsonMode = process.argv.includes("--json");

/** Output structured JSON and exit. */
export function outputJson(data: Record<string, unknown>): never {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

/** Output a structured error and exit with code 1. */
export function outputJsonError(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): never {
  console.log(
    JSON.stringify({ error: true, code, message, ...extra }, null, 2),
  );
  process.exit(1);
}

export function warn(msg: string) {
  console.log(`  ${t.warning(SYM.warn)}  ${msg}`);
}

export function error(msg: string): never {
  console.log(`\n  ${t.error(SYM.cross)}  ${msg}\n`);
  process.exit(1);
}
