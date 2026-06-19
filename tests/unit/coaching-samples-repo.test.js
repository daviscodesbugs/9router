import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory fake adapter matching the better-sqlite-style surface the repos use.
const store = { rows: [] };
const fakeDb = {
  run(sql, params = []) {
    if (/^INSERT INTO coachingSamples/i.test(sql)) {
      const [id, comboName, studentModel, teacherModel, createdAt, servedBy, overallScore, status, data] = params;
      const existing = store.rows.findIndex((r) => r.id === id);
      const row = { id, comboName, studentModel, teacherModel, createdAt, servedBy, overallScore, status, data };
      if (existing >= 0) store.rows[existing] = row; else store.rows.push(row);
    }
  },
  get(sql, params = []) {
    if (/COUNT\(\*\)/i.test(sql)) return { c: filterRows(sql, params).length };
    if (/WHERE id = \?/i.test(sql)) return store.rows.find((r) => r.id === params[0]) || undefined;
    return undefined;
  },
  all(sql, params = []) {
    return filterRows(sql, params);
  },
  transaction(fn) { return fn(); },
};
function filterRows(sql, params) {
  let rows = [...store.rows];
  const whereMatch = sql.match(/WHERE (.+?)(?:\s+ORDER|\s+LIMIT|$)/is);
  if (whereMatch) {
    const conditions = whereMatch[1].split(/\s+AND\s+/i);
    conditions.forEach((cond, i) => {
      if (/studentModel = \?/i.test(cond)) rows = rows.filter((r) => r.studentModel === params[i]);
      if (/status = \?/i.test(cond)) rows = rows.filter((r) => r.status === params[i]);
      if (/comboName = \?/i.test(cond)) rows = rows.filter((r) => r.comboName === params[i]);
    });
  }
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => fakeDb }));

import {
  saveCoachingSample, getCoachingSample, listCoachingSamples, exportSamples,
} from "../../src/lib/db/repos/coachingSamplesRepo.js";

describe("coachingSamplesRepo", () => {
  beforeEach(() => { store.rows = []; });

  it("saves and reads back a record with parsed JSON fields", async () => {
    const id = await saveCoachingSample({
      comboName: "local-coach", studentModel: "spark1/x", teacherModel: "cc/y",
      servedBy: "student", prompt: { messages: [{ role: "user", content: "hi" }] },
      studentAnswer: "stud", referenceAnswer: "ref",
      critique: { weaknesses: ["w1"] }, overallScore: 7, status: "ok", tokens: null,
    });
    expect(typeof id).toBe("string");
    const got = await getCoachingSample(id);
    expect(got.studentAnswer).toBe("stud");
    expect(got.critique.weaknesses).toEqual(["w1"]);
    expect(got.overallScore).toBe(7);
  });

  it("exportSamples returns only ok rows by default", async () => {
    await saveCoachingSample({ comboName: "c", studentModel: "s", servedBy: "student", prompt: {}, studentAnswer: "a", referenceAnswer: "r", critique: {}, overallScore: 5, status: "ok" });
    await saveCoachingSample({ comboName: "c", studentModel: "s", servedBy: "student", prompt: {}, studentAnswer: "a", referenceAnswer: "", critique: null, overallScore: null, status: "teacher_error" });
    const ok = await exportSamples({});
    expect(ok).toHaveLength(1);
    expect(ok[0].status).toBe("ok");
  });

  it("listCoachingSamples returns paginated results", async () => {
    await saveCoachingSample({ comboName: "c1", studentModel: "s1", servedBy: "student", prompt: {}, studentAnswer: "a1", referenceAnswer: "r1", critique: {}, overallScore: 5, status: "ok" });
    await saveCoachingSample({ comboName: "c2", studentModel: "s2", servedBy: "student", prompt: {}, studentAnswer: "a2", referenceAnswer: "r2", critique: {}, overallScore: 6, status: "ok" });
    const result = await listCoachingSamples({});
    expect(result.samples).toHaveLength(2);
    expect(result.pagination.totalItems).toBe(2);
    expect(result.pagination.totalPages).toBe(1);
  });
});
