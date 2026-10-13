import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "@/lib/dataDir.js";

const LOG_SUBPATH = "logs/refusal-fallback.jsonl";

/** Extract plain text from a message content (string or parts array). */
function msgText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(p => p?.type === "text").map(p => p.text ?? "").join("");
  }
  return "";
}

/** 12-hex sha256 of (system prompt + "\n" + first user message text). */
export function conversationFingerprint(body) {
  const messages = body?.messages ?? [];
  const sys = msgText(messages.find(m => m.role === "system")?.content ?? "");
  const firstUser = msgText(messages.find(m => m.role === "user")?.content ?? "");
  return createHash("sha256").update(sys + "\n" + firstUser).digest("hex").slice(0, 12);
}

// ponytail: per-path warn-once; upgrade to LRU if paths are dynamic/unbounded
const _warnedPaths = new Set();

/**
 * Append one JSONL entry to the refusal log.
 * @param {object} entry
 * @param {{ file?: string }} [opts]
 */
export function logRefusalCheck(entry, { file } = {}) {
  const target = file ?? path.join(getDataDir(), LOG_SUBPATH);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    if (!_warnedPaths.has(target)) {
      _warnedPaths.add(target);
      console.warn("[refusalLog] could not write log:", err?.message ?? err);
    }
  }
}
