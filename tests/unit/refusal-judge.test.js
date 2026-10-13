import { describe, it, expect } from "vitest";
import {
  REFUSAL_DEFAULTS,
  REFUSAL_QUESTIONS,
  resolveRefusalConfig,
  lastUserText,
  judgeRefusal,
} from "../../open-sse/services/refusalJudge.js";

const fake = (r, p, pr) => async () => ({
  answers: { refusal: { noul: r }, partial: { noul: p }, protective: { noul: pr } },
  ms: 5,
});

const cfg = resolveRefusalConfig({ enabled: true });

describe("REFUSAL_DEFAULTS", () => {
  it("has expected fields", () => {
    expect(REFUSAL_DEFAULTS).toMatchObject({
      threshold: 0.8,
      partialMax: 0.5,
      protectiveMax: 0.5,
      maxChars: 6000,
      maxHops: 2,
      enabled: false,
    });
  });
});

describe("resolveRefusalConfig", () => {
  it("defaults enabled false when not passed", () => {
    expect(resolveRefusalConfig().enabled).toBe(false);
  });
  it("enabled true only when raw.enabled === true", () => {
    expect(resolveRefusalConfig({ enabled: true }).enabled).toBe(true);
    expect(resolveRefusalConfig({ enabled: 1 }).enabled).toBe(false);
    expect(resolveRefusalConfig({ enabled: "true" }).enabled).toBe(false);
  });
  it("merges custom threshold", () => {
    expect(resolveRefusalConfig({ threshold: 0.9 }).threshold).toBe(0.9);
  });
});

describe("REFUSAL_QUESTIONS", () => {
  it("has refusal, partial, protective with type noul", () => {
    for (const key of ["refusal", "partial", "protective"]) {
      expect(REFUSAL_QUESTIONS[key].type).toBe("noul");
      expect(typeof REFUSAL_QUESTIONS[key].instructions).toBe("string");
    }
  });
  it("does not include refusal_short", () => {
    expect(REFUSAL_QUESTIONS).not.toHaveProperty("refusal_short");
  });
  it("refusal instructions verbatim", () => {
    expect(REFUSAL_QUESTIONS.refusal.instructions).toBe(
      "In `assistant_response`, the assistant declines to do the task requested in " +
      "`user_request` on policy, safety, or ethical grounds. This is NOT the case when " +
      "the assistant reports a technical limitation or error, asks a clarifying question, " +
      "quotes or drafts refusal wording because the user asked for it, explains a policy " +
      "the user asked about, or substantially completes the task while adding a caveat."
    );
  });
  it("partial instructions verbatim", () => {
    expect(REFUSAL_QUESTIONS.partial.instructions).toBe(
      "Besides anything it declines, `assistant_response` substantially completes at least one part of what `user_request` asked for."
    );
  });
  it("protective instructions verbatim", () => {
    expect(REFUSAL_QUESTIONS.protective.instructions).toBe(
      "The assistant is declining to perform a destructive or irreversible action (deleting data, wiping systems, running a dangerous command) on the user's own systems."
    );
  });
});

describe("lastUserText", () => {
  it("returns last user string content", () => {
    const body = { messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "last" },
    ]};
    expect(lastUserText(body)).toBe("last");
  });

  it("handles parts: skips non-text, concatenates text parts", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "..." } },
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]}]};
    expect(lastUserText(body)).toBe("ab");
  });

  it("truncates to 4000 chars", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(5000) }]};
    expect(lastUserText(body)).toHaveLength(4000);
  });

  it("returns empty string when no user message", () => {
    expect(lastUserText({ messages: [{ role: "assistant", content: "hi" }] })).toBe("");
    expect(lastUserText({})).toBe("");
  });
});

describe("judgeRefusal detection order", () => {
  const apiKey = "test-key";

  it("tool calls → keep skip:tool_calls (even with content_filter)", async () => {
    const ask = fake(0.99, 0.01, 0.01);
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "I cannot", finishReason: "content_filter", hasToolCalls: true },
      cfg, { ask, apiKey }
    );
    expect(r).toEqual({ decision: "keep", path: "skip:tool_calls" });
  });

  it("content_filter → fallback shortcut, no Jev call", async () => {
    const ask = async () => { throw new Error("should not be called"); };
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "blocked", finishReason: "content_filter", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(r).toEqual({ decision: "fallback", path: "shortcut:content_filter" });
  });

  it("empty text → keep skip:empty", async () => {
    const ask = fake(0.99, 0.01, 0.01);
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(r).toEqual({ decision: "keep", path: "skip:empty" });
  });

  it("reasoning-only answer is skip:empty", async () => {
    const ask = fake(0.99, 0.01, 0.01);
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(r).toEqual({ decision: "keep", path: "skip:empty" });
  });

  it("over maxChars → keep skip:max_chars", async () => {
    const ask = fake(0.99, 0.01, 0.01);
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "x".repeat(6001), finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(r).toEqual({ decision: "keep", path: "skip:max_chars" });
  });

  it("no key → keep skip:no_key", async () => {
    const ask = fake(0.99, 0.01, 0.01);
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "I cannot", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey: undefined }
    );
    expect(r).toEqual({ decision: "keep", path: "skip:no_key" });
  });

  it("clear refusal → fallback path jev with scores", async () => {
    const ask = fake(0.97, 0.04, 0.11);
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "I cannot do that", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(r.decision).toBe("fallback");
    expect(r.path).toBe("jev");
    expect(r.scores).toEqual({ refusal: 0.97, partial: 0.04, protective: 0.11 });
    expect(typeof r.jevMs).toBe("number");
  });

  it("partial refusal → keep", async () => {
    const ask = fake(0.92, 0.95, 0.77);
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "I cannot do that but here is some info", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(r.decision).toBe("keep");
    expect(r.path).toBe("jev");
    expect(r.scores).toEqual({ refusal: 0.92, partial: 0.95, protective: 0.77 });
  });

  it("protective refusal → keep", async () => {
    const ask = fake(0.85, 0.16, 0.97);
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "I won't run rm -rf on prod", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(r.decision).toBe("keep");
    expect(r.path).toBe("jev");
  });

  it("non-refusal → keep", async () => {
    const ask = fake(0.34, 0.90, 0.34);
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "Here is your answer", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(r.decision).toBe("keep");
    expect(r.path).toBe("jev");
  });

  it("Jev error → keep jev_error with jevMs", async () => {
    const ask = async () => ({ error: "HTTP 500", ms: 3 });
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "I cannot do that", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(r).toEqual({ decision: "keep", path: "jev_error", jevMs: 3 });
  });

  it("malformed Jev answers (missing answers) → keep jev_error", async () => {
    const ask = async () => ({ answers: undefined, ms: 7 });
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "I cannot do that", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(r).toEqual({ decision: "keep", path: "jev_error", jevMs: 7 });
  });

  it("malformed Jev answers (missing noul) → keep jev_error", async () => {
    const ask = async () => ({ answers: { refusal: {}, partial: { noul: 0.5 }, protective: { noul: 0.1 } }, ms: 9 });
    const r = await judgeRefusal(
      { userRequest: "u", assistantText: "I cannot do that", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(r).toEqual({ decision: "keep", path: "jev_error", jevMs: 9 });
  });

  it("sends user_request and assistant_response as state", async () => {
    let capturedArgs;
    const ask = async (args) => {
      capturedArgs = args;
      return { answers: { refusal: { noul: 0.1 }, partial: { noul: 0.1 }, protective: { noul: 0.1 } }, ms: 5 };
    };
    await judgeRefusal(
      { userRequest: "the user said this", assistantText: "the assistant said that", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey }
    );
    expect(capturedArgs.state).toEqual({
      user_request: "the user said this",
      assistant_response: "the assistant said that",
    });
  });

  it("passes apiKey and questions to ask", async () => {
    let capturedArgs;
    const ask = async (args) => {
      capturedArgs = args;
      return { answers: { refusal: { noul: 0.1 }, partial: { noul: 0.1 }, protective: { noul: 0.1 } }, ms: 5 };
    };
    await judgeRefusal(
      { userRequest: "u", assistantText: "text", finishReason: "stop", hasToolCalls: false },
      cfg, { ask, apiKey: "my-key" }
    );
    expect(capturedArgs.apiKey).toBe("my-key");
    expect(capturedArgs.questions).toBe(REFUSAL_QUESTIONS);
  });
});
