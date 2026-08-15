import { createInterface } from "node:readline";
import chalk from "chalk";
import pkg from "../../package.json";
import { redactKey } from "../redact";

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

export async function selectProviderInteractive(detectedLocal?: string | null): Promise<"opencode" | "local" | "cloudflare"> {
  const localDesc = detectedLocal
    ? `Ollama, LM Studio... (${t.success(`Detected ${detectedLocal}`)})`
    : "Ollama, LM Studio, Llama.cpp…";

  const result = await select(
    "Choose your AI provider",
    [
      `${t.primary("OpenCode")}     ${t.muted("Free cloud models (Zen/Go) — Zero setup")}`,
      `${t.primary("Local")}        ${t.muted(localDesc)}`,
      `${t.primary("Cloudflare")}   ${t.muted("Workers AI via AI Gateway")}`,
    ],
    { allowCustom: false, defaultIndex: 0 },
  );
  if (result.index === 1) return "local";
  if (result.index === 2) return "cloudflare";
  return "opencode";
}

export async function selectClientInteractive(
  clientStatus?: Record<string, boolean>,
  defaultClient?: string,
): Promise<string> {
  const clients = [
    { id: "claude", name: "Claude Code", desc: "Anthropic's AI coding assistant" },
    { id: "codex", name: "Codex", desc: "OpenAI's terminal coding agent" },
    { id: "opencode", name: "OpenCode", desc: "Open-source coding agent (opencode.ai)" },
    { id: "pi", name: "Pi", desc: "The Pi coding agent (pi.dev)" },
    { id: "server", name: "Server", desc: "Run proxy server only (no client launcher)" },
  ];

  let defaultIdx = 0;
  const options = clients.map((c, i) => {
    if (defaultClient && c.id === defaultClient) {
      defaultIdx = i;
    }
    const statusText = clientStatus && c.id !== "server"
      ? (clientStatus[c.id] ? t.success(" ✓ installed") : t.muted(" ○ auto-installs"))
      : "";
    return `${t.primary(c.name.padEnd(12))}${statusText ? statusText.padEnd(20) : " ".repeat(20)}  ${t.muted(c.desc)}`;
  });

  const result = await select("Launch which client?", options, {
    allowCustom: false,
    defaultIndex: defaultIdx,
  });
  return clients[result.index]?.id || "claude";
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
export async function input(question: string, defaultValue?: string, sensitive = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const displayDefault = sensitive && defaultValue ? redactKey(defaultValue) : defaultValue;
  const suffix = displayDefault ? ` ${t.muted(`[${displayDefault}]`)}` : "";
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

export interface SelectOptions {
  allowCustom?: boolean;
  defaultIndex?: number;
  customLabel?: string;
}

/** Numbered selection menu */
export async function select<T extends string>(
  label: string,
  options: T[],
  config: SelectOptions = {},
): Promise<{ value: T; index: number }> {
  const allowCustom = config.allowCustom ?? true;
  const defaultIndex = config.defaultIndex;

  console.log(`\n  ${t.secondary("?")}  ${label}\n`);
  for (let i = 0; i < options.length; i++) {
    const isDefault = defaultIndex === i;
    const defaultTag = isDefault ? ` ${t.muted("[Enter]")}` : "";
    console.log(`    ${t.primary(String(i + 1).padStart(2))}  ${options[i]}${defaultTag}`);
  }
  const extra = allowCustom ? options.length + 1 : options.length;
  if (allowCustom) {
    const customLabel = config.customLabel || "Custom (enter manually)";
    console.log(
      `    ${t.primary(String(extra).padStart(2))}  ${t.muted(customLabel)}\n`,
    );
  } else {
    console.log();
  }

  const defaultHint = defaultIndex !== undefined ? `, default: ${defaultIndex + 1}` : "";

  while (true) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`  ${t.muted(`Enter choice [1-${extra}${defaultHint}]`)} `, (a) => {
        rl.close();
        resolve(a.trim());
      });
    });

    if (answer === "" && defaultIndex !== undefined && defaultIndex >= 0 && defaultIndex < options.length) {
      return { value: options[defaultIndex], index: defaultIndex };
    }

    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= extra) {
      if (allowCustom && num === extra) return { value: "" as T, index: -1 };
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
