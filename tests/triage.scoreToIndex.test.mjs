// Run: node tests/triage.scoreToIndex.test.mjs   (no framework)
import assert from "node:assert/strict";
import { scoreToIndex } from "../open-sse/services/triage.js";

const L = 3; // 3-level rubric → score range 0..2

// Proportional mapping across a 3-model combo [cheap, mid, flagship]
assert.equal(scoreToIndex(0.0, L, 3), 0, "trivial → cheapest");
assert.equal(scoreToIndex(1.0, L, 3), 1, "moderate → middle");
assert.equal(scoreToIndex(2.0, L, 3), 2, "hard → flagship");
assert.equal(scoreToIndex(1.6, L, 3), 2, "between levels rounds up toward flagship");

// Clamps: never past the ends, whatever the score
assert.equal(scoreToIndex(-5, L, 3), 0, "clamps low");
assert.equal(scoreToIndex(99, L, 3), 2, "clamps high");

// Combo length independence
assert.equal(scoreToIndex(2.0, L, 5), 4, "hard → last of 5");
assert.equal(scoreToIndex(0.0, L, 5), 0, "trivial → first of 5");
assert.equal(scoreToIndex(1.0, L, 2), 1, "2-model combo: moderate rounds to flagship");

// Explicit cuts override (ascending score thresholds; #below = index)
assert.equal(scoreToIndex(0.5, L, 3, [0.7, 1.5]), 0, "below first cut");
assert.equal(scoreToIndex(1.0, L, 3, [0.7, 1.5]), 1, "between cuts");
assert.equal(scoreToIndex(1.9, L, 3, [0.7, 1.5]), 2, "above both cuts");
assert.equal(scoreToIndex(9, L, 3, [0.7, 1.5]), 2, "cuts still clamp to n-1");

console.log("triage scoreToIndex: all assertions passed");
