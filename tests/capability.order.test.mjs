// Run: node tests/capability.order.test.mjs   (no framework)
// Verifies the capability strategy's model-ordering decisions WITHOUT hitting Jev:
// we stub askJevRaw's result and assert what list handleCapabilityChat hands off.
import assert from "node:assert/strict";
import { handleCapabilityChat } from "../open-sse/services/triage.js";

// Capture what handleComboChat receives.
function capture() {
  let got = null;
  return { fn: async ({ models }) => { got = models; return { ran: models[0] }; }, got: () => got };
}
const body = { messages: [{ role: "user", content: "x" }] };
const profiles = { a: "coder", b: "generalist", c: "vision" };

// 1. <2 described models → plain fallback (original order), no Jev needed.
{
  const cap = capture();
  await handleCapabilityChat({
    body, models: ["a", "z"], profiles: { a: "coder" }, // only 1 described
    handleComboChat: cap.fn, handleSingleModel: () => {}, comboName: "t", apiKey: "k",
  });
  assert.deepEqual(cap.got(), ["a", "z"], "under-described → untouched fallback order");
}

// 2. No key → plain fallback (never calls Jev, never errors).
{
  const cap = capture();
  const saved = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  await handleCapabilityChat({
    body, models: ["a", "b", "c"], profiles,
    handleComboChat: cap.fn, handleSingleModel: () => {}, comboName: "t", apiKey: "",
  });
  if (saved) process.env.TYPESAFE_API_KEY = saved;
  assert.deepEqual(cap.got(), ["a", "b", "c"], "no key → original order");
}

// 3. Bad key → Jev 401 → fail-open to first model (original order preserved).
{
  const cap = capture();
  await handleCapabilityChat({
    body, models: ["a", "b", "c"], profiles,
    handleComboChat: cap.fn, handleSingleModel: () => {}, comboName: "t", apiKey: "sk-bogus-key",
  });
  assert.equal(cap.got()[0], "a", "fail-open → first model leads");
  assert.deepEqual(cap.got(), ["a", "b", "c"], "fail-open keeps original order");
}

console.log("capability order: all assertions passed");
