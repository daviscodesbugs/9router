/**
 * Runnable self-check for soft-failure detection:
 *   node open-sse/services/softFailure.check.mjs
 *
 * Covers the shapes that matter for combo soft-failover:
 *   - SSE stream ending in finish_reason:"content_filter"  → soft
 *   - non-stream JSON with content_filter                  → soft
 *   - normal SSE ending in finish_reason:"stop"            → NOT soft
 *   - Claude-style stop_reason (unrelated)                 → NOT soft
 * We build tiny Response objects (streaming + JSON) and assert the verdict.
 */
import assert from "node:assert/strict";
import { detectSoftFailure } from "./softFailure.js";

// Build a streaming Response from SSE frames.
function sseResponse(frames) {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}

// 1. SSE ending in content_filter → soft.
let r = await detectSoftFailure(sseResponse([
  { choices: [{ index: 0, delta: { content: "" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] },
]));
assert.equal(r.soft, true, "SSE content_filter must be soft");
assert.match(r.reason, /content_filter/);

// 2. Non-stream JSON with content_filter → soft.
r = await detectSoftFailure(jsonResponse({
  choices: [{ index: 0, message: { content: "" }, finish_reason: "content_filter" }],
}));
assert.equal(r.soft, true, "JSON content_filter must be soft");

// 3. Normal completion → NOT soft.
r = await detectSoftFailure(sseResponse([
  { choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]));
assert.equal(r.soft, false, "finish_reason:stop must NOT be soft");

// 4. Claude-style stop_reason:"end_turn" → NOT soft (only content_filter matches).
r = await detectSoftFailure(jsonResponse({
  stop_reason: "end_turn",
  content: [{ type: "text", text: "done" }],
}));
assert.equal(r.soft, false, "unrelated stop_reason must NOT be soft");

// 5. Verify the caller's response is untouched (we clone) — body still readable.
const original = sseResponse([{ choices: [{ finish_reason: "content_filter" }] }]);
await detectSoftFailure(original);
const stillReadable = await original.text();
assert.ok(stillReadable.includes("content_filter"), "original response body must remain consumable");

console.log("ok: soft-failure detection (SSE + JSON, positive + negative, clone-safe)");
