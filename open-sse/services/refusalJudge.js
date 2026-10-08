import { askJev } from "./jev.js";

export const REFUSAL_DEFAULTS = {
  threshold: 0.8,
  partialMax: 0.5,
  protectiveMax: 0.5,
  maxChars: 6000,
  maxHops: 2,
  enabled: false,
};

export const REFUSAL_QUESTIONS = {
  refusal: {
    type: "noul",
    instructions:
      "In `assistant_response`, the assistant declines to do the task requested in " +
      "`user_request` on policy, safety, or ethical grounds. This is NOT the case when " +
      "the assistant reports a technical limitation or error, asks a clarifying question, " +
      "quotes or drafts refusal wording because the user asked for it, explains a policy " +
      "the user asked about, or substantially completes the task while adding a caveat.",
  },
  partial: {
    type: "noul",
    instructions:
      "Besides anything it declines, `assistant_response` substantially completes at least one part of what `user_request` asked for.",
  },
  protective: {
    type: "noul",
    instructions:
      "The assistant is declining to perform a destructive or irreversible action (deleting data, wiping systems, running a dangerous command) on the user's own systems.",
  },
};

export function resolveRefusalConfig(raw = {}) {
  return {
    ...REFUSAL_DEFAULTS,
    ...raw,
    enabled: raw.enabled === true,
  };
}

/** Last user message text, first 4000 chars. */
export function lastUserText(body) {
  const msgs = body?.messages;
  if (!msgs) return "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    const c = msgs[i].content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.filter(p => p.type === "text").map(p => p.text).join("")
        : "";
    return text.slice(0, 4000);
  }
  return "";
}

/**
 * Decide whether an assistant response is a policy refusal.
 * Never throws.
 */
export async function judgeRefusal(
  { userRequest, assistantText, finishReason, hasToolCalls },
  config,
  { ask = askJev, apiKey = process.env.TYPESAFE_API_KEY } = {}
) {
  const { threshold, partialMax, protectiveMax, maxChars } = config;

  // Step 1
  if (hasToolCalls) return { decision: "keep", path: "skip:tool_calls" };
  // Step 2
  if (finishReason === "content_filter") return { decision: "fallback", path: "shortcut:content_filter" };
  // Step 3
  if (!assistantText) return { decision: "keep", path: "skip:empty" };
  // Step 4
  if (assistantText.length > maxChars) return { decision: "keep", path: "skip:max_chars" };
  // Step 5
  if (!apiKey) return { decision: "keep", path: "skip:no_key" };

  // Step 6: Jev
  const result = await ask({ state: { user_request: userRequest, assistant_response: assistantText }, questions: REFUSAL_QUESTIONS, apiKey });

  if (result.error) return { decision: "keep", path: "jev_error", jevMs: result.ms };

  const a = result.answers;
  const r = a?.refusal?.noul;
  const p = a?.partial?.noul;
  const pr = a?.protective?.noul;
  if (typeof r !== "number" || typeof p !== "number" || typeof pr !== "number") {
    return { decision: "keep", path: "jev_error", jevMs: result.ms };
  }

  const scores = { refusal: r, partial: p, protective: pr };
  const fallback = r >= threshold && p < partialMax && pr < protectiveMax;
  return { decision: fallback ? "fallback" : "keep", path: "jev", scores, jevMs: result.ms };
}
