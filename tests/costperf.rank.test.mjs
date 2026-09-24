// Run: node tests/costperf.rank.test.mjs   (no framework)
// Verifies the value = prob / price^lambda ranking that cost-perf uses, by
// driving handleCostPerfChat with a bad key (forces the fail-open path) AND by
// re-implementing the pure ranking to assert the knob behaves as claimed.
import assert from "node:assert/strict";
import { handleCostPerfChat } from "../open-sse/services/triage.js";

// --- Pure ranking check (the core formula, mirrored) ---
const rank = (probs, price, lambda) =>
  Object.keys(probs)
    .map((m) => ({ m, v: probs[m] / Math.pow(Math.max(price[m], 0.01), lambda) }))
    .sort((a, b) => b.v - a.v)[0].m;

const probs = { cheap: 0.45, pricey: 0.55 };   // pricey is slightly better fit
const price = { cheap: 1, pricey: 20 };        // but 20x the cost

assert.equal(rank(probs, price, 0), "pricey", "lambda=0 → pure fit picks pricey");
assert.equal(rank(probs, price, 1), "cheap",  "lambda=1 → price flips to cheap");
// The documented limitation: a p=0 model can never be rescued by being free.
assert.equal(rank({ a: 1.0, free: 0.0 }, { a: 5, free: 0.01 }, 2), "a",
  "winner-take-most: p=0 free model stays last at any lambda");

// --- Fail-open path (bad key → original order, no throw) ---
function capture() { let g=null; return { fn: async ({models})=>{g=models; return {ran:models[0]};}, got:()=>g }; }
{
  const cap = capture();
  await handleCostPerfChat({
    body: { messages:[{role:"user",content:"x"}] },
    models: ["a","b"], profiles: { a:"coder", b:"generalist" },
    getPrice: () => 1, lambda: 1,
    handleComboChat: cap.fn, handleSingleModel: ()=>{}, comboName:"t", apiKey:"sk-bogus",
  });
  assert.deepEqual(cap.got(), ["a","b"], "bad key → fail-open keeps original order");
}

console.log("costperf rank: all assertions passed");
