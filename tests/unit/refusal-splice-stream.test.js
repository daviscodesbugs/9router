import { describe, it, expect, vi } from "vitest";
import {
  fallbackMarker,
  EXHAUSTED_MARKER,
  MARKER_RE,
  spliceRefusals,
} from "../../open-sse/services/refusalSplice.js";
import { resolveRefusalConfig } from "../../open-sse/services/refusalJudge.js";

// ---- helpers -------------------------------------------------------------

const enc = new TextEncoder();

const chunk = (id, content, finish = null, extra = {}) => ({
  id,
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: [{ index: 0, delta: content != null ? { content } : {}, finish_reason: finish }],
  ...extra,
});

/** Build a text/event-stream Response from frame objects. Pull-based so cancel works mid-stream. */
function sse(frames, { done = true, chunkSize, crlf = false } = {}) {
  const sep = crlf ? "\r\n\r\n" : "\n\n";
  let text = frames.map(f => `data: ${JSON.stringify(f)}${sep}`).join("");
  if (done) text += `data: [DONE]${sep}`;
  const bytes = enc.encode(text);
  const parts = [];
  if (chunkSize) for (let i = 0; i < bytes.length; i += chunkSize) parts.push(bytes.slice(i, i + chunkSize));
  else parts.push(bytes);
  let i = 0;
  const cancelSpy = vi.fn();
  const stream = new ReadableStream({
    pull(controller) {
      if (i < parts.length) controller.enqueue(parts[i++]);
      else controller.close();
    },
    cancel(reason) { cancelSpy(reason); },
  });
  const res = new Response(stream, { headers: { "content-type": "text/event-stream" } });
  res.cancelSpy = cancelSpy;
  return res;
}

/** A stream that emits the given frames then hangs forever (until cancelled). */
function hangingSse(frames) {
  const sep = "\n\n";
  const bytes = enc.encode(frames.map(f => `data: ${JSON.stringify(f)}${sep}`).join(""));
  let sent = false;
  const cancelSpy = vi.fn();
  const stream = new ReadableStream({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(bytes); return; }
      return new Promise(() => {}); // hang
    },
    cancel(reason) { cancelSpy(reason); },
  });
  const res = new Response(stream, { headers: { "content-type": "text/event-stream" } });
  res.cancelSpy = cancelSpy;
  return res;
}

async function readAll(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

function framesOf(text) {
  return text.split(/\r?\n\r?\n/).filter(s => s.trim()).map(s => {
    const line = s.split(/\r?\n/).find(l => l.startsWith("data:"));
    const data = line.slice(5).replace(/^ /, "");
    return data === "[DONE]" ? "[DONE]" : JSON.parse(data);
  });
}

const contentsOf = (text) =>
  framesOf(text).filter(f => f !== "[DONE]").map(f => f.choices?.[0]?.delta?.content).filter(c => c != null);

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

// ---- marker exports ------------------------------------------------------

describe("markers", () => {
  it("fallbackMarker is the exact contract string", () => {
    expect(fallbackMarker("cc/a", "cx/b")).toBe("\n\n⟦9r:refusal-fallback from=cc/a to=cx/b⟧\n\n");
    expect(EXHAUSTED_MARKER).toBe("\n\n⟦9r:refusal-fallback-exhausted⟧\n\n");
  });
  it("MARKER_RE captures from/to", () => {
    const m = fallbackMarker("cc/a", "cx/b").match(MARKER_RE);
    expect(m.groups.from).toBe("cc/a");
    expect(m.groups.to).toBe("cx/b");
  });
});

// ---- streaming splice ----------------------------------------------------

describe("spliceRefusals streaming", () => {
  it("passes a non-refusal through with all frames in order", async () => {
    const a = sse([chunk("a1", "hello"), chunk("a1", null, "stop")]);
    const res = await spliceRefusals(a, baseOpts({ judge: async () => ({ decision: "keep", path: "jev" }) }));
    const out = framesOf(await readAll(res));
    expect(out).toEqual([chunk("a1", "hello"), chunk("a1", null, "stop"), "[DONE]"]);
  }, T);

  it("forwards content frames before the judge resolves", async () => {
    let open;
    const gate = new Promise(r => { open = r; });
    const a = sse([chunk("a1", "live"), chunk("a1", null, "stop")]);
    const res = await spliceRefusals(a, baseOpts({ judge: async () => { await gate; return { decision: "keep", path: "jev" }; } }));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const first = await reader.read();           // readable while gate is closed
    expect(dec.decode(first.value)).toContain('"live"');
    open();
    // drain the rest so the stream closes cleanly
    for (;;) { const { done } = await reader.read(); if (done) break; }
  }, T);

  it("splices: marker then next model frames with A's id", async () => {
    const a = sse([chunk("a1", "I can't"), chunk("a1", null, "stop")]);
    const b = sse([chunk("b1", "Sure"), chunk("b1", null, "stop")]);
    const res = await spliceRefusals(a, baseOpts({
      judge: async () => ({ decision: "fallback", path: "jev" }),
      next: async () => b,
    }));
    const text = await readAll(res);
    expect(contentsOf(text)).toEqual(["I can't", fallbackMarker("cc/a", "cx/b"), "Sure"]);
    const parsed = framesOf(text).filter(f => f !== "[DONE]");
    // every B chunk id rewritten to A's id
    for (const f of parsed) expect(f.id).toBe("a1");
    // A's finish chunk absent, B's finish present
    const finishes = parsed.filter(f => f.choices?.[0]?.finish_reason === "stop");
    expect(finishes).toHaveLength(1);
    expect(finishes[0].model).toBe("m"); // B's real model left intact
  }, T);

  it("emits exactly one DONE after a splice", async () => {
    const a = sse([chunk("a1", "I can't"), chunk("a1", null, "stop")]);
    const b = sse([chunk("b1", "Sure"), chunk("b1", null, "stop")]);
    const res = await spliceRefusals(a, baseOpts({
      judge: async () => ({ decision: "fallback", path: "jev" }),
      next: async () => b,
    }));
    const text = await readAll(res);
    expect((text.match(/\[DONE\]/g) || []).length).toBe(1);
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  }, T);

  it("exhausted when next() is non-ok: marker then A's held frames", async () => {
    const a = sse([chunk("a1", "I can't"), chunk("a1", null, "stop")]);
    const res = await spliceRefusals(a, baseOpts({
      judge: async () => ({ decision: "fallback", path: "jev" }),
      next: async () => new Response(JSON.stringify({ error: "x" }), { status: 503 }),
    }));
    const text = await readAll(res);
    expect(contentsOf(text)).toEqual(["I can't", EXHAUSTED_MARKER]);
    expect(text).not.toContain("refusal-fallback from=");
    const parsed = framesOf(text).filter(f => f !== "[DONE]");
    expect(parsed.some(f => f.choices?.[0]?.finish_reason === "stop")).toBe(true); // A's held finish released
    expect((text.match(/\[DONE\]/g) || []).length).toBe(1);
  }, T);

  it("exhausted when next() throws", async () => {
    const a = sse([chunk("a1", "I can't"), chunk("a1", null, "stop")]);
    const res = await spliceRefusals(a, baseOpts({
      judge: async () => ({ decision: "fallback", path: "jev" }),
      next: async () => { throw new Error("boom"); },
    }));
    const text = await readAll(res);
    expect(contentsOf(text)).toEqual(["I can't", EXHAUSTED_MARKER]);
    expect((text.match(/\[DONE\]/g) || []).length).toBe(1);
  }, T);

  it("keeps without judging at maxHops", async () => {
    const a = sse([chunk("a1", "I can't"), chunk("a1", null, "stop")]);
    const res = await spliceRefusals(a, baseOpts({
      hop: 2,
      judge: async () => { throw new Error("judge must not run at maxHops"); },
    }));
    expect(res).toBe(a); // original response untouched
  }, T);

  it("keeps when upstream returned tool calls", async () => {
    let seen;
    const a = sse([
      { id: "a1", object: "chat.completion.chunk", created: 1, model: "m",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "f" } }] }, finish_reason: null }] },
      chunk("a1", null, "tool_calls"),
    ]);
    const res = await spliceRefusals(a, baseOpts({
      judge: async (input) => { seen = input; return { decision: "keep", path: "skip:tool_calls" }; },
    }));
    await readAll(res);
    expect(seen.hasToolCalls).toBe(true);
  }, T);

  it("judges only text after an inner marker", async () => {
    let seen;
    const inner = fallbackMarker("x/y", "z/w") + "real";
    const a = sse([chunk("a1", inner), chunk("a1", null, "stop")]);
    const res = await spliceRefusals(a, baseOpts({
      judge: async (input) => { seen = input; return { decision: "keep", path: "jev" }; },
    }));
    await readAll(res);
    expect(seen.assistantText).toBe("real");
  }, T);

  it("reassembles frames split across reads (chunkSize 7)", async () => {
    const a = sse([chunk("a1", "hello world"), chunk("a1", null, "stop")], { chunkSize: 7 });
    const res = await spliceRefusals(a, baseOpts());
    const out = framesOf(await readAll(res));
    expect(out).toEqual([chunk("a1", "hello world"), chunk("a1", null, "stop"), "[DONE]"]);
  }, T);

  it("reassembles CRLF-terminated frames split across reads", async () => {
    const a = sse([chunk("a1", "hello world"), chunk("a1", null, "stop")], { chunkSize: 5, crlf: true });
    const res = await spliceRefusals(a, baseOpts());
    const out = framesOf(await readAll(res));
    expect(out.map(f => f === "[DONE]" ? f : f.choices[0].delta.content ?? null))
      .toEqual(["hello world", null, "[DONE]"]);
  }, T);

  it("closes when upstream ends without terminal frames", async () => {
    const a = sse([chunk("a1", "partial answer")], { done: false });
    const res = await spliceRefusals(a, baseOpts());
    const text = await readAll(res);                 // must terminate, not hang
    expect(contentsOf(text)).toEqual(["partial answer"]);
  }, T);

  it("accumulates only delta.content; reasoning-only answer judges empty text", async () => {
    let seen;
    const reasoningFrame = { id: "a1", object: "chat.completion.chunk", created: 1, model: "m",
      choices: [{ index: 0, delta: { reasoning_content: "thinking..." }, finish_reason: null }] };
    const a = sse([reasoningFrame, chunk("a1", null, "stop")]);
    const res = await spliceRefusals(a, baseOpts({
      judge: async (input) => { seen = input; return { decision: "keep", path: "skip:empty" }; },
    }));
    const out = framesOf(await readAll(res));
    expect(seen.assistantText).toBe("");
    expect(out[0]).toEqual(reasoningFrame); // forwarded unchanged
  }, T);

  it("judge throwing keeps the response", async () => {
    const a = sse([chunk("a1", "hello"), chunk("a1", null, "stop")]);
    const res = await spliceRefusals(a, baseOpts({
      judge: async () => { throw new Error("judge blew up"); },
    }));
    const out = framesOf(await readAll(res));
    expect(out).toEqual([chunk("a1", "hello"), chunk("a1", null, "stop"), "[DONE]"]);
  }, T);

  it("cancel propagates to the active upstream (A mid-stream)", async () => {
    const a = hangingSse([chunk("a1", "I can't")]);
    const res = await spliceRefusals(a, baseOpts({ judge: async () => ({ decision: "keep", path: "jev" }) }));
    const reader = res.body.getReader();
    await reader.read();            // first A frame forwarded
    await reader.cancel("client gone");
    await new Promise(r => setTimeout(r, 10));
    expect(a.cancelSpy).toHaveBeenCalled();
  }, T);

  it("cancel propagates to the active upstream (B after splice)", async () => {
    const a = sse([chunk("a1", "I can't"), chunk("a1", null, "stop")]);
    const b = hangingSse([chunk("b1", "Sure")]);
    const res = await spliceRefusals(a, baseOpts({
      judge: async () => ({ decision: "fallback", path: "jev" }),
      next: async () => b,
    }));
    const reader = res.body.getReader();
    // read until we see B's content, then cancel
    const dec = new TextDecoder();
    for (;;) { const { value } = await reader.read(); if (dec.decode(value).includes("Sure")) break; }
    await reader.cancel("client gone");
    await new Promise(r => setTimeout(r, 10));
    expect(b.cancelSpy).toHaveBeenCalled();
  }, T);

  it("logs one check per hop with decision and to", async () => {
    const logCheck = vi.fn();
    const a = sse([chunk("a1", "I can't"), chunk("a1", null, "stop")]);
    const b = sse([chunk("b1", "Sure"), chunk("b1", null, "stop")]);
    const res = await spliceRefusals(a, baseOpts({
      judge: async () => ({ decision: "fallback", path: "jev", scores: { refusal: 0.97 }, jevMs: 168 }),
      next: async () => b,
      logCheck,
    }));
    await readAll(res);
    expect(logCheck).toHaveBeenCalledTimes(1);
    expect(logCheck.mock.calls[0][0]).toMatchObject({
      combo: "main", model: "cc/a", hop: 0, path: "jev", decision: "fallback", to: "cx/b",
    });
    expect(logCheck.mock.calls[0][0].conversation).toMatch(/^[0-9a-f]{12}$/);
  }, T);

  it("non-SSE response is returned untouched", async () => {
    const json = new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    const res = await spliceRefusals(json, baseOpts());
    expect(res).toBe(json);
  }, T);

  it("keeps A's status and headers, drops content-length", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } });
    const a = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "content-length": "99", "x-foo": "bar" },
    });
    const res = await spliceRefusals(a, baseOpts({ judge: async () => ({ decision: "keep", path: "jev" }) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-foo")).toBe("bar");
    expect(res.headers.get("content-length")).toBe(null);
    await readAll(res);
  }, T);
});
