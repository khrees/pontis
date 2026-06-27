import { spawn, execSync } from "node:child_process";
import { existsSync, readdirSync, statSync, mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { select, input, createSpinner, badge, section, t } from "./ui";
import { DIST_PROXY, SRC_DIR, ROOT, PONTIS_DIR, PROXY_LOG } from "./config";

export const PORT = 8787;
export const PROXY_URL = `http://localhost:${PORT}`;

/** Tracked proxy PID so SIGINT/SIGTERM can clean it up. */
export let activeProxy: { pid: number } | null = null;

export function setActiveProxy(proxy: { pid: number } | null) {
  activeProxy = proxy;
}

export function killActiveProxy() {
  if (activeProxy) {
    try {
      process.kill(activeProxy.pid, "SIGTERM");
    } catch {}
    activeProxy = null;
  }
}

/** Register a one-shot shutdown handler. */
export function onShutdown(handler: () => void) {
  const done = () => {
    handler();
    process.exit(0);
  };
  process.on("SIGINT", done);
  process.on("SIGTERM", done);
}

export function needsProxyRebuild(): boolean {
  if (!existsSync(SRC_DIR)) return false;
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

export function buildProxy() {
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

export function findNativeBinary(): string | null {
  for (const p of [
    join(ROOT, "bin", "pontis-proxy"),
    join(ROOT, "pontis-proxy"),
  ]) {
    if (existsSync(p)) return p;
  }
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

export async function startProxy(model: string, codexMode: boolean): Promise<number> {
  // Kill existing proxy
  try {
    const existing = execSync(`lsof -t -i :${PORT} 2>/dev/null || true`)
      .toString()
      .trim();
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
