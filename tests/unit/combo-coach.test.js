import { describe, it, expect, vi } from "vitest";
import {
  handleCoachChat, buildCoachPrompt, parseCoachCritique, extractAnswerFromResponse,
} from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function okResponse(content) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, clone: make, json: async () => json, text: async () => JSON.stringify(json) });
  return make();
}

// A teacher response whose content is the critique JSON envelope.
function critiqueResponse(obj) {
  return okResponse(JSON.stringify(obj));
}

const CRITIQUE = {
  reference_answer: "the better answer",
  scores: { correctness: 8, completeness: 7, style: 9, overall: 8 },
  strengths: ["clear"], weaknesses: ["missed edge case"],
  failure_modes: ["overconfident"], suggested_system_prompt_additions: ["cite sources"],
  suggested_template_changes: [], notes: "ok",
};

describe("parseCoachCritique", () => {
  it("parses a clean JSON object", () => {
    const { critique, status } = parseCoachCritique(JSON.stringify(CRITIQUE));
    expect(status).toBe("ok");
    expect(critique.scores.overall).toBe(8);
  });
  it("parses JSON wrapped in prose / fences", () => {
    const { critique, status } = parseCoachCritique("Here:\n```json\n" + JSON.stringify(CRITIQUE) + "\n```\nDone");
    expect(status).toBe("ok");
    expect(critique.weaknesses).toEqual(["missed edge case"]);
  });
  it("flags unparseable text", () => {
    const { critique, status } = parseCoachCritique("no json here");
    expect(status).toBe("parse_failed");
    expect(critique).toBeNull();
  });
});

describe("extractAnswerFromResponse", () => {
  it("reads non-streaming JSON content", async () => {
    const txt = await extractAnswerFromResponse(okResponse("hello"));
    expect(txt).toBe("hello");
  });
  it("reconstructs SSE delta stream", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"foo"}}]}\n\ndata: {"choices":[{"delta":{"content":"bar"}}]}\n\ndata: [DONE]\n\n';
    const res = { ok: true, headers: { get: () => "text/event-stream" }, clone: () => res, text: async () => sse };
    const txt = await extractAnswerFromResponse(res);
    expect(txt).toBe("foobar");
  });
});

describe("coach combo", () => {
  it("serves the student answer and harvests a sample (serveMode=student)", async () => {
    const calls = [];
    const persisted = [];
    const handleSingleModel = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "cc/teacher") return critiqueResponse(CRITIQUE);
      return okResponse("student says");
    });
    const res = await handleCoachChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["spark1/student", "cc/teacher"],
      handleSingleModel, log, comboName: "local-coach",
      studentModel: "spark1/student", teacherModel: "cc/teacher", serveMode: "student",
      persistSample: (r) => persisted.push(r),
    });
    // The served response is the student's.
    expect(await extractAnswerFromResponse(res)).toBe("student says");
    // Student was called first.
    expect(calls[0]).toBe("spark1/student");
    // Allow the fire-and-forget harvest to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe("ok");
    expect(persisted[0].servedBy).toBe("student");
    expect(persisted[0].studentAnswer).toBe("student says");
    expect(persisted[0].referenceAnswer).toBe("the better answer");
    expect(persisted[0].overallScore).toBe(8);
  });

  it("records a teacher_error sample but still serves the student answer", async () => {
    const persisted = [];
    const handleSingleModel = vi.fn(async (b, m) => {
      if (m === "cc/teacher") throw new Error("teacher down");
      return okResponse("student says");
    });
    const res = await handleCoachChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["spark1/student", "cc/teacher"],
      handleSingleModel, log, comboName: "local-coach",
      studentModel: "spark1/student", teacherModel: "cc/teacher", serveMode: "student",
      persistSample: (r) => persisted.push(r),
    });
    expect(await extractAnswerFromResponse(res)).toBe("student says");
    await new Promise((r) => setTimeout(r, 10));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe("teacher_error");
  });

  it("skips harvest entirely when no teacher is available", async () => {
    const persisted = [];
    const handleSingleModel = vi.fn(async () => okResponse("student says"));
    await handleCoachChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["spark1/student"],
      handleSingleModel, log, comboName: "local-coach",
      studentModel: "spark1/student", teacherModel: "", serveMode: "student",
      persistSample: (r) => persisted.push(r),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(persisted).toHaveLength(0);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });
});
