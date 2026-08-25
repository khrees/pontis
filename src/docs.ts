import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DOCS_HTML_CONTENT } from "./docs-html";

let cachedHtml: string | null = null;

/**
 * Returns the full interactive HTML content for the /docs documentation and web UI.
 */
export function getDocsHtml(): string {
  if (cachedHtml && process.env.NODE_ENV === "production") {
    return cachedHtml;
  }

  const candidatePaths: string[] = [
    join(process.cwd(), "docs", "index.html"),
    join(homedir(), ".pontis", "docs", "index.html"),
  ];

  if (typeof __dirname !== "undefined") {
    candidatePaths.push(
      join(__dirname, "..", "docs", "index.html"),
      join(__dirname, "docs", "index.html"),
      join(__dirname, "index.html"),
    );
  }

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        cachedHtml = content;
        return content;
      } catch {}
    }
  }

  // Fall back to the fully bundled 1,000+ line interactive documentation
  cachedHtml = DOCS_HTML_CONTENT;
  return DOCS_HTML_CONTENT;
}
