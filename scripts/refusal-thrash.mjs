import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

function defaultFile() {
  const base = process.env.DATA_DIR ?? path.join(os.homedir(), ".9router");
  return path.join(base, "logs", "refusal-fallback.jsonl");
}

/** Nearest-rank percentile (1-indexed). Returns null for empty arrays. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * @param {object[]} entries
 * @returns {{ checks, byPath, fallbacks, conversationsWithFallback, thrashConversations, jevMsP50, jevMsP95 }}
 */
export function summarize(entries) {
  const byPath = {};
  const fallbackConvIds = new Set();
  const fallbacksByConv = {};
  const jevMsTimes = [];
  let fallbacks = 0;

  for (const e of entries) {
    byPath[e.path] = (byPath[e.path] ?? 0) + 1;
    if (e.decision === "fallback") {
      fallbacks++;
      if (e.conversation) {
        fallbackConvIds.add(e.conversation);
        fallbacksByConv[e.conversation] = (fallbacksByConv[e.conversation] ?? 0) + 1;
      }
    }
    if (typeof e.jevMs === "number") jevMsTimes.push(e.jevMs);
  }

  jevMsTimes.sort((a, b) => a - b);
  const thrashConversations = Object.values(fallbacksByConv).filter(n => n >= 2).length;

  return {
    checks: entries.length,
    byPath,
    fallbacks,
    conversationsWithFallback: fallbackConvIds.size,
    thrashConversations,
    jevMsP50: percentile(jevMsTimes, 50),
    jevMsP95: percentile(jevMsTimes, 95),
  };
}

// CLI entry point
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? defaultFile();
  let entries = [];
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw) entries = raw.split("\n").map(l => JSON.parse(l));
  } catch (err) {
    if (err.code !== "ENOENT") {
      process.stderr.write(`[refusal-thrash] error reading ${file}: ${err.message}\n`);
      process.exit(1);
    }
  }
  process.stdout.write(JSON.stringify(summarize(entries), null, 2) + "\n");
}
