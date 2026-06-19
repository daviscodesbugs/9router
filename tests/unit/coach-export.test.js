import { describe, it, expect } from "vitest";
import { formatSample } from "../../src/app/api/coaching/export/route.js";

const rec = {
  prompt: { messages: [{ role: "user", content: "Q" }] },
  studentAnswer: "stud", referenceAnswer: "ref",
  critique: { scores: { overall: 8 } }, overallScore: 8, status: "ok",
  studentModel: "s/x", comboName: "c",
};

describe("formatSample", () => {
  it("sft → messages + completion (reference answer)", () => {
    const out = formatSample(rec, "sft");
    expect(out.messages).toEqual(rec.prompt.messages);
    expect(out.completion).toBe("ref");
  });
  it("dpo → chosen=reference, rejected=student", () => {
    const out = formatSample(rec, "dpo");
    expect(out.chosen).toBe("ref");
    expect(out.rejected).toBe("stud");
  });
  it("raw → full record", () => {
    const out = formatSample(rec, "raw");
    expect(out.studentAnswer).toBe("stud");
    expect(out.referenceAnswer).toBe("ref");
  });
});
