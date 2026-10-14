/**
 * Soft-failure detection for combo fallback.
 *
 * The combo executor's default success test is `result.ok` (HTTP 2xx). But some
 * providers return a *successful* 2xx that carries no usable content — most
 * commonly a content-moderation refusal surfaced as
 * `finish_reason: "content_filter"` with an empty/near-empty message. HTTP-level
 * fallback never sees these, so the empty success is returned to the caller.
 *
 * This module inspects a cloned 2xx body (streaming SSE or plain JSON), extracts
 * the aggregate finish_reason + text, and matches it against SOFT_FAILURE_RULES.
 * It is OPT-IN (combo executor only calls it when soft-failover is enabled),
 * because reading the body means buffering it — which defeats live token
 * streaming. Fine for background/evaluator calls; off by default for interactive.
 *
 * ponytail: rule-based (finish_reason + substring) is the ceiling here.
 * add when: you want semantic "is this answer actually a refusal/non-answer"
 * judgement — call an LLM (Jev) in `classify()` behind the same interface.
 */

import { SOFT_FAILURE_RULES } from "../config/errorConfig.js";

// Cap how much of a streamed body we buffer while sniffing for a terminal
// finish_reason, so a runaway/huge success can't blow up memory. The
// finish_reason lives in the final chunk, so we read to the end — but a
// well-behaved completion is far under this.
const MAX_SNIFF_BYTES = 2 * 1024 * 1024;

/**
 * Read a Response body to text with a hard byte cap. Returns the decoded text
 * (possibly truncated). Does not consume the caller's response — pass a clone.
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function readCapped(res) {
  if (!res.body || typeof res.body.getReader !== "function") {
    // No stream (e.g. already-buffered) — fall back to .text().
    try {
      const t = await res.text();
      return t.length > MAX_SNIFF_BYTES ? t.slice(0, MAX_SNIFF_BYTES) : t;
    } catch {
      return "";
    }
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < MAX_SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    // Partial read is fine — we match on whatever we got.
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
  return out;
}

/**
 * Pull the last non-null finish_reason and concatenated assistant text out of a
 * raw response body, handling both SSE ("data: {...}" frames) and a single JSON
 * object. Best-effort and format-tolerant (OpenAI chat + Claude-ish shapes).
 * @param {string} raw
 * @returns {{ finishReason: string|null, text: string }}
 */
function extractOutcome(raw) {
  let finishReason = null;
  let text = "";

  const consume = (obj) => {
    if (!obj || typeof obj !== "object") return;
    const choice = obj.choices?.[0];
    if (choice) {
      const fr = choice.finish_reason ?? choice.delta?.finish_reason;
      if (fr) finishReason = fr;
      const c = choice.delta?.content ?? choice.message?.content;
      if (typeof c === "string") text += c;
    }
    // Claude messages: stop_reason on the top level or a message_delta.
    const sr = obj.stop_reason ?? obj.delta?.stop_reason;
    if (sr) finishReason = sr;
  };

  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{")) {
    // Non-stream JSON body.
    try { consume(JSON.parse(trimmed)); } catch { /* ignore */ }
    return { finishReason, text };
  }

  // SSE: iterate "data:" payloads.
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { consume(JSON.parse(payload)); } catch { /* ignore */ }
  }
  return { finishReason, text };
}

/**
 * Decide whether a successful (2xx) combo response is actually a soft failure
 * that should trigger fallback to the next model.
 *
 * @param {Response} response - the 2xx response (NOT consumed; we clone it)
 * @returns {Promise<{ soft: boolean, reason: string|null }>}
 */
export async function detectSoftFailure(response) {
  let raw;
  try {
    raw = await readCapped(response.clone());
  } catch {
    return { soft: false, reason: null };
  }
  if (!raw) return { soft: false, reason: null };

  const { finishReason, text } = extractOutcome(raw);
  const lowerRaw = raw.toLowerCase();

  for (const rule of SOFT_FAILURE_RULES) {
    if (rule.finishReason && finishReason === rule.finishReason) {
      return { soft: true, reason: `finish_reason:${finishReason}` };
    }
    if (rule.text && lowerRaw.includes(rule.text.toLowerCase())) {
      return { soft: true, reason: `matched:${rule.text}` };
    }
  }

  // Hook: a semantic classifier (Jev) could go here, e.g. when a rule opts in
  // with { classify: true }, ask an LLM whether `text` is a genuine non-answer.
  // Left out on purpose — rules cover the current need (content_filter).
  void text;

  return { soft: false, reason: null };
}
