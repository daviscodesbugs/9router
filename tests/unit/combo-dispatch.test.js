import { describe, it, expect, vi } from "vitest";

// Stub the persist bridge so the dispatcher never touches the real DB during the test.
vi.mock("../../src/sse/services/coachHarvest.js", () => ({
  makePersistSample: () => async () => {},
}));

import { dispatchComboStrategy } from "../../src/sse/handlers/comboDispatch.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };
const body = { messages: [{ role: "user", content: "hi" }] };

function makeHandleSingleModel() {
  return vi.fn(async (b, m) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, clone() { return this; }, json: async () => ({ choices: [{ message: { content: `ans-${m}` } }] }), text: async () => "{}" }));
}

describe("dispatchComboStrategy", () => {
  it("routes a coach combo to the coach engine", async () => {
    const settings = { comboStrategies: { "local-coach": { fallbackStrategy: "coach", studentModel: "s/x", judgeModel: "t/y", serveMode: "student" } } };
    const res = await dispatchComboStrategy({
      modelStr: "local-coach", comboModels: ["s/x", "t/y"], settings, body,
      makeHandleSingleModel, log,
    });
    expect(res).toBeTruthy();
    expect(res.ok).toBe(true);
  });

  it("returns a fallback combo Response for default strategy", async () => {
    const settings = { comboStrategies: {} };
    const res = await dispatchComboStrategy({
      modelStr: "plain-combo", comboModels: ["a/1", "a/2"], settings, body,
      makeHandleSingleModel, log,
    });
    expect(res).toBeTruthy();
  });
});
