import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import { handleComboChat, getRotatedModels, resetComboRotation } from "../../open-sse/services/combo.js";
import { isOpenAIChatRequest } from "../../open-sse/services/refusalSplice.js";

import { askJev } from "../../open-sse/services/jev.js";
vi.mock("../../open-sse/services/jev.js", () => ({ askJev: vi.fn() }));

// ---- helpers -------------------------------------------------------------

const enc = new TextEncoder();
const log = { info() {}, warn() {} };

/** Build a text/event-stream Response. finish=content_filter triggers the judge shortcut. */
function sse(content, finish = "stop") {
  const frames = [
    { id: "x", object: "chat.completion.chunk", created: 1, model: "m",
      choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { id: "x", object: "chat.completion.chunk", created: 1, model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ];
  const text = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(enc.encode(text), { headers: { "content-type": "text/event-stream" } });
}

/** JSON (non-stream) error response → combo loop falls through to next model. */
function httpError(status) {
  return new Response(JSON.stringify({ error: { message: "boom" } }),
    { status, headers: { "content-type": "application/json" } });
}

async function readAll(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) { const { value, done } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
  return out + dec.decode();
}

const refusalCfg = (over = {}) => ({ enabled: true, ...over });

let tmp;
beforeEach(() => {
  vi.clearAllMocks();
  resetComboRotation();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refusal-"));
  process.env.DATA_DIR = tmp;
});
afterEach(() => {
  resetComboRotation();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- tests ---------------------------------------------------------------

describe("handleComboChat refusal fallback", () => {
  it("disabled config returns model A as before", async () => {
    const calls = [];
    const handleSingleModel = (b, m) => { calls.push(m); return Promise.resolve(sse("A answer", "content_filter")); };
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"], handleSingleModel, log, comboName: "c",
      clientFormat: "openai", // but no refusalFallback → no splice
    });
    const out = await readAll(res);
    expect(out).toContain("A answer");
    expect(out).not.toContain("refusal-fallback from");
    expect(calls).toEqual(["p/a"]);
  });

  it("enabled: A content_filter → marker + B", async () => {
    const handleSingleModel = (b, m) =>
      Promise.resolve(m === "p/a" ? sse("I can't help", "content_filter") : sse("B helps"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"], handleSingleModel, log, comboName: "c",
      clientFormat: "openai", refusalFallback: refusalCfg(),
    });
    const out = await readAll(res);
    expect(out).toContain("⟦9r:refusal-fallback from=p/a to=p/b⟧"); // JSON-escaped newlines in the SSE frame
    expect(out).toContain("B helps");
  });

  it("non-openai clientFormat is untouched", async () => {
    const handleSingleModel = (b, m) => Promise.resolve(sse("A answer", "content_filter"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"], handleSingleModel, log, comboName: "c",
      clientFormat: null, refusalFallback: refusalCfg(),
    });
    const out = await readAll(res);
    expect(out).toContain("A answer");
    expect(out).not.toContain("refusal-fallback from");
  });

  it("last model is never wrapped", async () => {
    const handleSingleModel = (b, m) => Promise.resolve(sse("only A", "content_filter"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a"], handleSingleModel, log, comboName: "c",
      clientFormat: "openai", refusalFallback: refusalCfg(),
    });
    const out = await readAll(res);
    expect(out).toContain("only A");
    expect(out).not.toContain("refusal-fallback");
  });

  it("B HTTP error falls through to C via the inner loop", async () => {
    const handleSingleModel = (b, m) => {
      if (m === "p/a") return Promise.resolve(sse("refuse", "content_filter"));
      if (m === "p/b") return Promise.resolve(httpError(500));
      return Promise.resolve(sse("C helps"));
    };
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b", "p/c"], handleSingleModel, log, comboName: "c",
      clientFormat: "openai", refusalFallback: refusalCfg(),
    });
    const out = await readAll(res);
    expect(out).toContain("⟦9r:refusal-fallback from=p/a to=p/b⟧"); // marker names the first next model
    expect(out).toContain("C helps");
  });

  it.each([
    ["fallback", undefined],
    ["fallback", { enabled: false }],
    ["round-robin", { enabled: true }],
    ["fusion", { enabled: true }],
  ])("%s with config %j never calls Jev", async (comboStrategy, refusalFallback) => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    try {
      const response = sse("A reply");
      const res = await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["p/a", "p/b"], handleSingleModel: async () => response,
        log, comboName: "gated", comboStrategy, clientFormat: "openai", refusalFallback,
      });
      expect(res).toBe(response);
      await readAll(res);
      expect(askJev).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it("checked fallback calls Jev and retries", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    askJev.mockResolvedValue({ answers: {
      refusal: { noul: 0.99 }, partial: { noul: 0 }, protective: { noul: 0 },
    }, ms: 1 });
    try {
      const res = await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["p/a", "p/b"], handleSingleModel: async (_, model) => sse(model === "p/a" ? "Declined" : "B helps"),
        log, comboName: "checked", comboStrategy: "fallback", clientFormat: "openai", refusalFallback: refusalCfg(),
      });
      expect(await readAll(res)).toContain("B helps");
      expect(askJev).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });

  it("hop limit stops a refusal chain", async () => {
    const calls = [];
    const handleSingleModel = (b, m) => { calls.push(m); return Promise.resolve(sse(`refuse-${m}`, "content_filter")); };
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b", "p/c"], handleSingleModel, log, comboName: "c",
      clientFormat: "openai", refusalFallback: refusalCfg({ maxHops: 1 }),
    });
    const out = await readAll(res);
    const markers = out.match(/refusal-fallback from/g) || [];
    expect(markers.length).toBe(1);
    expect(calls).not.toContain("p/c");
  });

  it("isOpenAIChatRequest", () => {
    expect(isOpenAIChatRequest("/v1/chat/completions", {})).toBe(true);
    expect(isOpenAIChatRequest("/v1/messages", {})).toBe(false);
    expect(isOpenAIChatRequest("/v1/chat/completions", { input: [] })).toBe(false);
  });
});
