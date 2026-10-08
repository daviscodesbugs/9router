import { judgeRefusal, lastUserText } from "./refusalJudge.js";
import { logRefusalCheck, conversationFingerprint } from "./refusalLog.js";

const TAG = "refusalSplice";

// ---- Marker contract (exact strings from Global Constraints) -------------

export function fallbackMarker(from, to) {
  return `\n\n⟦9r:refusal-fallback from=${from} to=${to}⟧\n\n`;
}
export const EXHAUSTED_MARKER = "\n\n⟦9r:refusal-fallback-exhausted⟧\n\n";
export const MARKER_RE = /⟦9r:refusal-fallback from=(?<from>[^ ⟧]+) to=(?<to>[^ ⟧]+)⟧/;

// ---- SSE frame helpers ---------------------------------------------------

/** Parse one SSE frame's text (no trailing separator) into its data payload. */
function parseFrame(raw) {
  const dataLines = raw.split(/\r?\n/).filter(l => l.startsWith("data:"));
  if (dataLines.length === 0) return { raw, payload: null, parsed: null, done: false };
  const payload = dataLines.map(l => l.slice(5).replace(/^ /, "")).join("\n");
  if (payload === "[DONE]") return { raw, payload, parsed: null, done: true };
  let parsed = null;
  try { parsed = JSON.parse(payload); } catch { /* malformed → forwarded, ignored */ }
  return { raw, payload, parsed, done: false };
}

/** A frame is held (not forwarded live) if it is terminal. */
function isHeld(f) {
  if (f.done) return true;
  if (!f.parsed) return false;
  const ch = f.parsed.choices;
  if (Array.isArray(ch) && ch.length > 0 && ch[0].finish_reason != null) return true;
  if ((!Array.isArray(ch) || ch.length === 0) && f.parsed.usage) return true;
  return false;
}

const frameStr = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = "data: [DONE]\n\n";

function markerChunk(id, created, model, marker) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { content: marker }, finish_reason: null }],
  };
}

/** Text after the last fallback marker (a nested combo already spliced). */
function afterLastMarker(text) {
  const re = new RegExp(MARKER_RE.source, "g");
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m;
  return last ? text.slice(last.index + last[0].length).replace(/^\s+/, "") : text;
}

// ---- Splice --------------------------------------------------------------

export async function spliceRefusals(response, opts) {
  const { config, hop } = opts;
  if (hop >= config.maxHops) return response;
  const ct = response.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) return response; // non-SSE: Task 5
  return streamSplice(response, opts);
}

function streamSplice(response, opts) {
  const {
    body: reqBody, modelStr, nextModel, hop, config, log, comboName, next,
    judge = judgeRefusal, logCheck = logRefusalCheck,
  } = opts;

  const enc = new TextEncoder();
  let activeReader = null;
  let cancelled = false;

  const send = (controller, s) => { try { controller.enqueue(enc.encode(s)); } catch { /* cancelled */ } };

  async function run(controller) {
    const held = [];
    let accText = "";
    let hasToolCalls = false;
    let aId = null, aCreated = null, finishReason = null;

    // --- read model A ---
    const reader = response.body.getReader();
    activeReader = reader;
    const dec = new TextDecoder();
    let buf = "";

    const handleAFrame = (raw) => {
      const f = parseFrame(raw);
      if (f.parsed) {
        if (f.parsed.id != null) aId = f.parsed.id;
        if (f.parsed.created != null) aCreated = f.parsed.created;
      }
      if (isHeld(f)) {
        if (f.parsed) {
          const fr = f.parsed.choices?.[0]?.finish_reason;
          if (fr != null) finishReason = fr;
        }
        held.push(raw);
        return;
      }
      if (f.parsed) {
        const delta = f.parsed.choices?.[0]?.delta;
        if (delta?.content) accText += delta.content;
        if (delta?.tool_calls) hasToolCalls = true;
      }
      send(controller, raw + "\n\n");
    };

    for (;;) {
      let r;
      try { r = await reader.read(); } catch { return; }
      if (cancelled) return;
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop();
      for (const p of parts) if (p.trim()) handleAFrame(p);
    }
    buf += dec.decode();
    if (buf.trim()) handleAFrame(buf); // trailing frame without a terminator
    activeReader = null;
    if (cancelled) return;

    // --- judge (fail-soft to keep) ---
    let decision;
    try {
      const result = await judge(
        { userRequest: lastUserText(reqBody), assistantText: afterLastMarker(accText), finishReason, hasToolCalls },
        config,
      );
      decision = result && result.decision ? result : { decision: "keep", path: "judge_error" };
    } catch (err) {
      log?.warn?.(TAG, "judge threw; keeping", { err: err?.message });
      decision = { decision: "keep", path: "judge_error" };
    }

    const entry = {
      combo: comboName, model: modelStr, hop,
      path: decision.path, scores: decision.scores, jevMs: decision.jevMs,
      decision: decision.decision, conversation: conversationFingerprint(reqBody),
    };
    if (decision.decision === "fallback") entry.to = nextModel;
    try { logCheck(entry); } catch { /* never throws into the stream */ }

    // --- keep: release held frames in order ---
    if (decision.decision !== "fallback") {
      for (const raw of held) send(controller, raw + "\n\n");
      return;
    }

    // --- fallback ---
    const id = aId ?? ("chatcmpl-9r-" + Math.random().toString(36).slice(2, 12));
    const created = aCreated ?? Math.floor(Date.now() / 1000);

    let bRes = null;
    try { bRes = await next(); }
    catch (err) { log?.warn?.(TAG, "next() threw; exhausted", { err: err?.message }); }
    if (cancelled) return;

    if (!bRes || !bRes.ok || !bRes.body) {
      // exhausted: A's answer stands
      send(controller, frameStr(markerChunk(id, created, modelStr, EXHAUSTED_MARKER)));
      for (const raw of held) send(controller, raw + "\n\n");
      if (!held.some(r => parseFrame(r).done)) send(controller, DONE);
      return;
    }

    // splice: marker, then B's frames with A's id (B is already fully spliced)
    send(controller, frameStr(markerChunk(id, created, modelStr, fallbackMarker(modelStr, nextModel))));
    const bReader = bRes.body.getReader();
    activeReader = bReader;
    const bdec = new TextDecoder();
    let bbuf = "";
    const handleBFrame = (raw) => {
      const f = parseFrame(raw);
      if (f.parsed && f.parsed.id != null) { f.parsed.id = id; send(controller, frameStr(f.parsed)); }
      else send(controller, raw + "\n\n");
    };
    for (;;) {
      let r;
      try { r = await bReader.read(); } catch { return; }
      if (cancelled) return;
      if (r.done) break;
      bbuf += bdec.decode(r.value, { stream: true });
      const parts = bbuf.split(/\r?\n\r?\n/);
      bbuf = parts.pop();
      for (const p of parts) if (p.trim()) handleBFrame(p);
    }
    bbuf += bdec.decode();
    if (bbuf.trim()) handleBFrame(bbuf);
  }

  const stream = new ReadableStream({
    async start(controller) {
      try { await run(controller); }
      catch (err) { log?.warn?.(TAG, "splice stream error", { err: err?.message }); }
      finally { try { controller.close(); } catch { /* already closed/cancelled */ } }
    },
    async cancel(reason) {
      cancelled = true;
      if (activeReader) { try { await activeReader.cancel(reason); } catch { /* ignore */ } }
    },
  });

  const headers = new Headers(response.headers);
  headers.delete("content-length"); // body length changes
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}
