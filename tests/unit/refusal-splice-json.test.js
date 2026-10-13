import { describe, it, expect, vi } from "vitest";
import { spliceRefusals } from "../../open-sse/services/refusalSplice.js";
import { resolveRefusalConfig } from "../../open-sse/services/refusalJudge.js";

// ---- helpers -------------------------------------------------------------

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const completion = (content = "hello", finish_reason = "stop", tool_calls = undefined) => ({
  id: "chatcmpl-abc",
  object: "chat.completion",
  created: 1,
  model: "gpt-4",
  choices: [{ index: 0, message: { role: "assistant", content, tool_calls }, finish_reason }],
});

const baseOpts = (over = {}) => ({
  body: { messages: [{ role: "user", content: "hi" }] },
  modelStr: "cc/a",
  nextModel: "cx/b",
  hop: 0,
  config: resolveRefusalConfig({ enabled: true }),
  log: { info() {}, warn() {} },
  comboName: "main",
  next: async () => { throw new Error("next called unexpectedly"); },
  logCheck: () => {},
  judge: async () => ({ decision: "keep", path: "jev" }),
  ...over,
});

const T = 5000;

// ---- JSON splice ---------------------------------------------------------

describe("spliceRefusals JSON", () => {
  it("keep returns identical body", async () => {
    const body = completion("hello");
    const res = await spliceRefusals(jsonRes(body), baseOpts({
      judge: async () => ({ decision: "keep", path: "jev" }),
    }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(body);
  }, T);

  it("fallback returns next body with header \"cc/a->cx/b\"", async () => {
    const nextBody = completion("next answer");
    const res = await spliceRefusals(jsonRes(completion("refused")), baseOpts({
      judge: async () => ({ decision: "fallback", path: "jev" }),
      next: async () => jsonRes(nextBody),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-9r-refusal-fallback")).toBe("cc/a->cx/b");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(nextBody);
  }, T);

  it("next non-ok returns A's body", async () => {
    const aBody = completion("original");
    const res = await spliceRefusals(jsonRes(aBody), baseOpts({
      judge: async () => ({ decision: "fallback", path: "jev" }),
      next: async () => new Response("bad gateway", { status: 502 }),
    }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(aBody);
    expect(res.headers.get("x-9r-refusal-fallback")).toBeNull();
  }, T);

  it("next throws returns A's body", async () => {
    const aBody = completion("original");
    const res = await spliceRefusals(jsonRes(aBody), baseOpts({
      judge: async () => ({ decision: "fallback", path: "jev" }),
      next: async () => { throw new Error("upstream exploded"); },
    }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(aBody);
    expect(res.headers.get("x-9r-refusal-fallback")).toBeNull();
  }, T);

  it("invalid JSON body is returned unchanged", async () => {
    const raw = "not json at all";
    const res = await spliceRefusals(
      new Response(raw, { status: 200, headers: { "content-type": "application/json" } }),
      baseOpts({ judge: async () => ({ decision: "fallback", path: "jev" }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(raw);
  }, T);

  it("no marker text in fallback body", async () => {
    const nextBody = completion("clean answer");
    const res = await spliceRefusals(jsonRes(completion("refused")), baseOpts({
      judge: async () => ({ decision: "fallback", path: "jev" }),
      next: async () => jsonRes(nextBody),
    }));
    const text = await res.text();
    expect(text).not.toContain("⟦9r:");
  }, T);

  it("judge throwing keeps the response (json)", async () => {
    const aBody = completion("original");
    const res = await spliceRefusals(jsonRes(aBody), baseOpts({
      judge: async () => { throw new Error("judge exploded"); },
    }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(aBody);
  }, T);

  it("logs one check with decision and to (json)", async () => {
    const checks = [];
    const nextBody = completion("next");
    await spliceRefusals(jsonRes(completion("refused")), baseOpts({
      judge: async () => ({ decision: "fallback", path: "jev", scores: { refusal: 0.9 }, jevMs: 42 }),
      next: async () => jsonRes(nextBody),
      logCheck: (entry) => checks.push(entry),
    }));
    expect(checks).toHaveLength(1);
    expect(checks[0].decision).toBe("fallback");
    expect(checks[0].to).toBe("cx/b");
  }, T);
});
