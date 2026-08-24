import { createInterface, emitKeypressEvents, type Key } from "node:readline";
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
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

/** Display the brand splash on startup */
export function splash() {
  console.log(
    `  ${t.primary(SYM.diamond)} ${t.bold("Pontis")} ${t.muted(`v${VERSION}`)} — ${t.muted("Universal AI gateway")}`,
  );
}

/** Section header with title */
export function section(title: string) {
  console.log(`\n  ${t.primary(SYM.bullet)} ${t.bold(title)}`);
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
  console.log(`  ${colors[type](syms[type])} ${text}`);
}

/** Inline status (same-line update). No-op when stdout is not a TTY so cursor
 *  escapes don't end up in piped/logged output. */
const IS_OUT_TTY = Boolean(process.stdout.isTTY);

export function statusLine(text: string, symbol = SYM.dot) {
  if (!IS_OUT_TTY) return;
  process.stdout.write(`\r  ${t.muted(symbol)}  ${text}`);
}

export function clearLine() {
  if (!IS_OUT_TTY) return;
  process.stdout.write("\r\x1b[K");
}

export async function selectProviderInteractive(
  detectedLocal?: string | null,
  defaultProvider?: string | null,
): Promise<"opencode" | "local" | "cloudflare" | "google"> {
  const localDesc = detectedLocal
    ? `Ollama, LM Studio... (${t.success(`Detected ${detectedLocal}`)})`
    : "Ollama, LM Studio, Llama.cpp…";

  const providers: Array<"google" | "opencode" | "local" | "cloudflare"> = [
    "google",
    "opencode",
    "local",
    "cloudflare",
  ];

  let defaultIndex = 1; // Default to OpenCode
  if (defaultProvider) {
    const idx = providers.indexOf(defaultProvider as any);
    if (idx >= 0) defaultIndex = idx;
  }

  const items = [
    `${t.primary("Google (Gemini)".padEnd(18))} ${t.muted("Free Gemini & Gemma models (AI Studio key)")}`,
    `${t.primary("OpenCode".padEnd(18))} ${t.muted("Free cloud models (Zen/Go) — Zero setup")}`,
    `${t.primary("Local".padEnd(18))} ${t.muted(localDesc)}`,
    `${t.primary("Cloudflare".padEnd(18))} ${t.muted("Workers AI via AI Gateway")}`,
  ];

  const result = await select("Choose your AI provider", items, {
    allowCustom: false,
    defaultIndex,
  });
  return providers[result.index] || "opencode";
}

export async function selectClientInteractive(
  clientStatus?: Record<string, boolean>,
  defaultClient?: string,
): Promise<string> {
  const clients = [
    { id: "claude", name: "Claude Code", desc: "Anthropic's AI coding assistant" },
    { id: "codex", name: "Codex", desc: "OpenAI's terminal coding agent" },
    { id: "hermes", name: "Hermes Agent", desc: "Autonomous AI agent by Nous Research" },
    { id: "opencode", name: "OpenCode", desc: "Open-source coding agent (opencode.ai)" },
    { id: "pi", name: "Pi", desc: "The Pi coding agent (pi.dev)" },
    { id: "server", name: "Server", desc: "Run proxy server only (no client launcher)" },
  ];

  let defaultIdx = 0;
  const options = clients.map((c, i) => {
    if (defaultClient && c.id === defaultClient) {
      defaultIdx = i;
    }
    const isInst = clientStatus && clientStatus[c.id];
    const rawStatus =
      clientStatus && c.id !== "server"
        ? isInst
          ? "[installed]"
          : "[auto-install]"
        : "";
    const statusCol = rawStatus
      ? isInst
        ? t.success(rawStatus.padEnd(15))
        : t.muted(rawStatus.padEnd(15))
      : "".padEnd(15);
    return `${t.primary(c.name.padEnd(14))} ${statusCol} ${t.muted(c.desc)}`;
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
  const trimmed = question.trimEnd();
  const formattedPrompt = trimmed.endsWith(":") ? trimmed : `${trimmed}:`;
  return new Promise((resolve) => {
    let settled = false;
    rl.question(`  ${t.secondary("?")} ${formattedPrompt}${suffix} `, (answer) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
    // If stdin closes (EOF / non-interactive pipe) before an answer, the
    // question callback never fires — without this the CLI hangs forever.
    rl.on("close", () => {
      if (settled) return;
      settled = true;
      if (defaultValue !== undefined) {
        // Scripted/non-interactive: fall back to the provided default.
        resolve(defaultValue);
        return;
      }
      // A required value with no default can't be answered — fail fast with
      // guidance instead of hanging until the job/CI times out.
      console.error(
        `\n  ${t.error(SYM.cross)} This prompt needs an interactive terminal (stdin was closed).`,
      );
      console.error(
        `  ${t.muted("Run in a terminal, or pass the value non-interactively via a flag or env var (e.g. pontis auth set <provider> <key>).")}`,
      );
      process.exit(1);
    });
  });
}

/** Confirm prompt (y/n) */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  // Pass "" as the default so a closed/non-interactive stdin resolves to the
  // safe default rather than exiting — a confirm must never auto-proceed.
  const answer = await input(`${question} ${t.muted(`(${hint})`)}`, "");
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

/**
 * Prompt until the user enters a non-empty value, re-asking on blank. Use this
 * for "custom" entries (e.g. a model ID) where silently falling back to a list
 * default would be surprising. `validate` returns an error string to re-ask, or
 * null if the value is acceptable.
 */
export async function inputRequired(
  question: string,
  validate?: (value: string) => string | null,
): Promise<string> {
  for (;;) {
    const answer = (await input(question)).trim();
    if (answer) {
      if (validate) {
        const err = validate(answer);
        if (err) {
          badge("warning", err);
          continue;
        }
      }
      return answer;
    }
    badge("warning", "A value is required — enter one, or press Ctrl+C to cancel.");
  }
}

export interface SelectOptions {
  allowCustom?: boolean;
  defaultIndex?: number;
  customLabel?: string;
  pageSize?: number;
}

/** Numbered selection menu with keyboard navigation (Tab/Shift-Tab, Arrow keys, Numbers, PageUp/Down, Enter) */
export async function select<T extends string>(
  label: string,
  options: T[],
  config: SelectOptions = {},
): Promise<{ value: T; index: number }> {
  const allowCustom = config.allowCustom ?? true;
  const rawCustomLabel = config.customLabel || "Custom (enter manually)";
  const cleanCustomLabel = rawCustomLabel.replace(/^✏️\s*/, "").trim();

  const items: { label: string; value: T; isCustom?: boolean }[] = options.map((opt) => ({
    label: opt,
    value: opt,
  }));
  if (allowCustom) {
    items.push({ label: cleanCustomLabel || "Custom (enter manually)", value: "" as T, isCustom: true });
  }

  const initialIndex =
    config.defaultIndex !== undefined &&
    config.defaultIndex >= 0 &&
    config.defaultIndex < items.length
      ? config.defaultIndex
      : 0;

  // Non-TTY fallback (for CI, test runners, or non-interactive pipes)
  if (!process.stdin.isTTY) {
    console.log(`  ${t.secondary("?")} ${label}`);
    for (let i = 0; i < items.length; i++) {
      const isDefault = initialIndex === i;
      const defaultTag = isDefault ? ` ${t.muted("[Enter]")}` : "";
      console.log(`    ${t.primary(String(i + 1).padStart(2))} ${items[i].label}${defaultTag}`);
    }
    const extra = items.length;
    const defaultHint = `, default: ${initialIndex + 1}`;

    while (true) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await new Promise<string>((resolve) => {
        let settled = false;
        rl.question(`  ${t.muted(`Enter choice [1-${extra}${defaultHint}]:`)} `, (a) => {
          if (settled) return;
          settled = true;
          rl.close();
          resolve(a.trim());
        });
        // Closed stdin (CI / piped) never fires the question callback — fall
        // back to the default choice instead of hanging forever.
        rl.on("close", () => {
          if (settled) return;
          settled = true;
          console.error(`  ${t.muted(`(no interactive input — using default: ${initialIndex + 1})`)}`);
          resolve("");
        });
      });

      if (answer === "") {
        const item = items[initialIndex];
        return { value: item.value, index: item.isCustom ? -1 : initialIndex };
      }

      const num = parseInt(answer, 10);
      if (!isNaN(num) && num >= 1 && num <= extra) {
        const item = items[num - 1];
        return { value: item.value, index: item.isCustom ? -1 : num - 1 };
      }
      console.log(`  ${t.warning("Please enter 1–" + extra)}`);
    }
  }

  // Interactive TTY Mode with windowed pagination and keyboard navigation
  return new Promise((resolve) => {
    let selectedIndex = initialIndex;
    let renderedLines = 0;
    let numberBuffer = "";
    let numberTimer: NodeJS.Timeout | null = null;
    const PAGE_LIMIT = config.pageSize || 10;

    const render = () => {
      // Clear previously rendered lines (cursor control only works on a TTY)
      if (renderedLines > 0 && IS_OUT_TTY) {
        process.stdout.write(`\x1B[${renderedLines}A\x1B[0J`);
      }

      let output = `  ${t.secondary("?")} ${t.bold(label)} ${t.muted("(Tab/↑↓ navigate, Enter select)")}\n`;
      let lines = 1;

      const pageSize = Math.min(items.length, PAGE_LIMIT);
      let startIdx = 0;
      let endIdx = items.length;

      if (items.length > pageSize) {
        const half = Math.floor(pageSize / 2);
        if (selectedIndex <= half) {
          startIdx = 0;
          endIdx = pageSize;
        } else if (selectedIndex >= items.length - half) {
          startIdx = items.length - pageSize;
          endIdx = items.length;
        } else {
          startIdx = selectedIndex - half;
          endIdx = startIdx + pageSize;
        }
      }

      if (startIdx > 0) {
        output += `    ${t.muted(`▲ ${startIdx} more above`)}\n`;
        lines++;
      }

      for (let i = startIdx; i < endIdx; i++) {
        const isSelected = selectedIndex === i;
        const pointer = isSelected ? t.primary("❯") : " ";
        const num = String(i + 1).padStart(2);
        const itemLabel = items[i].label;

        if (isSelected) {
          output += `  ${pointer} ${t.bold(t.primary(num))} ${t.bold(t.accent(itemLabel))}\n`;
        } else {
          output += `  ${pointer} ${t.muted(num)} ${t.muted(itemLabel)}\n`;
        }
        lines++;
      }

      if (endIdx < items.length) {
        output += `    ${t.muted(`▼ ${items.length - endIdx} more below`)}\n`;
        lines++;
      }

      renderedLines = lines;
      process.stdout.write(output);
    };

    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Hide cursor during navigation (TTY only)
    if (IS_OUT_TTY) process.stdout.write("\x1B[?25l");
    render();

    const cleanup = () => {
      if (numberTimer) clearTimeout(numberTimer);
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      // Restore cursor (TTY only)
      if (IS_OUT_TTY) process.stdout.write("\x1B[?25h");
    };

    const onKeypress = (str: string, key: Key) => {
      const name = key?.name;
      const seq = key?.sequence || str || "";

      // Handle Ctrl+C — abort with the SIGINT exit code and a message so an
      // aborted wizard is distinguishable from a completed one.
      if ((key?.ctrl && name === "c") || seq === "\x03") {
        cleanup();
        console.log(`\n  ${t.muted("Cancelled.")}`);
        process.exit(130);
      }

      // Down / Next (Tab, Down arrow, j, \x1b[B)
      if (
        name === "down" ||
        name === "j" ||
        (name === "tab" && !key?.shift) ||
        seq === "\t" ||
        seq === "\x1B[B"
      ) {
        selectedIndex = (selectedIndex + 1) % items.length;
        render();
        return;
      }

      // Up / Prev (Shift+Tab, Up arrow, k, backtab, \x1b[Z, \x1b[A)
      if (
        name === "up" ||
        name === "k" ||
        (name === "tab" && key?.shift) ||
        name === "backtab" ||
        seq === "\x1B[Z" ||
        seq === "\x1B[A"
      ) {
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        render();
        return;
      }

      // Page Down / Page Up
      if (name === "pagedown" || seq === "\x1B[6~") {
        selectedIndex = Math.min(items.length - 1, selectedIndex + PAGE_LIMIT);
        render();
        return;
      }
      if (name === "pageup" || seq === "\x1B[5~") {
        selectedIndex = Math.max(0, selectedIndex - PAGE_LIMIT);
        render();
        return;
      }

      // Home / End
      if (name === "home" || seq === "\x1B[H") {
        selectedIndex = 0;
        render();
        return;
      }
      if (name === "end" || seq === "\x1B[F") {
        selectedIndex = items.length - 1;
        render();
        return;
      }

      // Direct number selection for short lists (<= 9 items)
      if (name && /^[1-9]$/.test(name) && items.length <= 9) {
        const num = parseInt(name, 10);
        if (num >= 1 && num <= items.length) {
          selectedIndex = num - 1;
          render();
          cleanup();
          const item = items[selectedIndex];
          resolve({ value: item.value, index: item.isCustom ? -1 : selectedIndex });
          return;
        }
      }

      // Number input to jump to item for long lists (> 9 items)
      if (name && /^[0-9]$/.test(name) && items.length > 9) {
        if (numberTimer) clearTimeout(numberTimer);
        numberBuffer += name;
        const num = parseInt(numberBuffer, 10);
        if (num >= 1 && num <= items.length) {
          selectedIndex = num - 1;
          render();
        }
        numberTimer = setTimeout(() => {
          numberBuffer = "";
        }, 700);
        return;
      }

      // Confirm (Enter, Return, Space, \r, \n)
      if (
        name === "return" ||
        name === "enter" ||
        name === "space" ||
        seq === "\r" ||
        seq === "\n" ||
        seq === " "
      ) {
        cleanup();
        const item = items[selectedIndex];
        resolve({ value: item.value, index: item.isCustom ? -1 : selectedIndex });
        return;
      }

      // Escape — treat as cancel (same as Ctrl+C).
      if (name === "escape" || seq === "\x1B") {
        cleanup();
        console.log(`\n  ${t.muted("Cancelled.")}`);
        process.exit(130);
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

/** Show a key-value pair */
export function kv(key: string, value: string) {
  console.log(`  ${t.muted(key.padEnd(16))} ${value}`);
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
  console.log(`  ${t.warning(SYM.warn)} ${msg}`);
}

export function error(msg: string): never {
  console.log(`\n  ${t.error(SYM.cross)} ${msg}\n`);
  process.exit(1);
}
