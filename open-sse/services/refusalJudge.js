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

function userMessageText(m) {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter(p => p.type === "text").map(p => p.text).join("");
  return "";
}

/**
 * The user's request for the judge: the most recent contiguous run of user
 * messages (skipping any trailing assistant/tool turns), joined with blank
 * lines, keeping the LAST 4000 chars. Clients like pi wrap the real request in
 * injected user turns (a bootstrap block before, a timestamp after), so taking
 * only the final user message can hand the judge a timestamp. Tail truncation
 * cuts a large leading bootstrap first and keeps the request.
 */
export function lastUserText(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs)) return "";
  let end = msgs.length - 1;
  while (end >= 0 && msgs[end]?.role !== "user") end--;
  if (end < 0) return "";
  let start = end;
  while (start > 0 && msgs[start - 1]?.role === "user") start--;
  const text = msgs.slice(start, end + 1).map(userMessageText).filter(Boolean).join("\n\n");
  return text.slice(-4000);
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
