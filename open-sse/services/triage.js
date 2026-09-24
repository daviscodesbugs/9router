/**
 * Triage combo strategy — Jev-scored routing.
 *
 * Combo model lists are ordered cheap→expensive. Instead of always starting at
 * model 0 (fallback) or fanning out to all (fusion), triage asks TypeSafe's Jev
 * model ONE calibrated difficulty question about the request, maps the score to
 * a STARTING INDEX in that ordered list, and hands off to handleComboChat from
 * there. Fallback-on-failure is inherited for free.
 *
 * One ~200ms input-only call (~$0.0002) per request. Fails OPEN to the flagship
 * (last model): a Jev error must never silently route hard work to a weak model,
 * because plain fallback only escalates on *failure*, not on a bad-but-"successful"
 * answer.
 */

import { extractTextContent } from "../translator/formats/gemini.js";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-1.13.0"; // pinned: thresholds are calibrated to a version, not an alias
const JEV_TIMEOUT_MS = 4000;

// One ordered rubric. Jev returns a probability-weighted score across these
// levels (0..2, can land between, e.g. 1.6). More levels ≠ better — 3 is plenty
// to spread across any combo length.
const DIFFICULTY = {
  type: "score",
  instructions:
    "How much model capability does correctly handling the user's most recent request require? Judge intrinsic difficulty — reasoning depth, planning, ambiguity, breadth of knowledge — not length.",
  criteria: [
    "Trivial: routine continuation, simple extraction/formatting, a small local model handles it",
    "Moderate: some reasoning, multi-step but well-scoped",
    "Hard: deep reasoning, planning, ambiguity, or long-range coherence — needs a flagship model",
  ],
};

/**
 * Serialize the state Jev sees: system prompt + last user turn only.
 * Small and cheap; enough to gauge intrinsic difficulty.
 * ponytail: last-user-turn only. Add a recent-message window (last N incl. tool
 * results) if routing misses accumulated context — build a compaction step then.
 */
function extractState(body) {
  const msgs = body?.messages || body?.input || null;
  let system = "";
  let user = "";
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      if (m?.role === "system") system = extractTextContent(m.content) || system;
      if (m?.role === "user") user = extractTextContent(m.content) || user; // last wins
    }
  } else if (Array.isArray(body?.contents)) {
    // Gemini shape: parts carry .text without a type discriminator
    const last = [...body.contents].reverse().find((c) => c?.role === "user" || !c?.role);
    user = (last?.parts || []).map((p) => p?.text || "").join("");
    system = body.systemInstruction?.parts?.map((p) => p?.text || "").join("") || "";
  }
  const state = [system && `System: ${system}`, `User: ${user}`].filter(Boolean).join("\n\n");
  return state.slice(0, 120_000); // ~32k-token state ceiling; head-keep is fine (system+user is short)
}

/**
 * Map Jev's difficulty score to a start index in the ordered combo list.
 * Proportional: score/(levels-1) scaled across the list. Zero per-model config,
 * works on any combo length.
 * ponytail: proportional mapping. Add an optional `cuts` threshold array to
 * tuning when a combo needs hand-tuned boundaries.
 */
export function scoreToIndex(score, levels, n, cuts) {
  if (Array.isArray(cuts) && cuts.length) {
    // cuts = ascending score thresholds; #below = start index
    return Math.min(cuts.filter((c) => score >= c).length, n - 1);
  }
  const frac = levels > 1 ? score / (levels - 1) : 0;
  return Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
}

async function askJevRaw(questions, state, apiKey) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), JEV_TIMEOUT_MS);
  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { json: await res.json() };
  } catch (e) {
    return { error: e.name };
  } finally {
    clearTimeout(t);
  }
}

async function askJev(state, apiKey, log) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), JEV_TIMEOUT_MS);
  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions: { difficulty: DIFFICULTY } }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log?.info?.("TRIAGE", `Jev HTTP ${res.status} — fail-open to flagship`);
      return null;
    }
    const json = await res.json();
    const a = json?.answers?.difficulty;
    if (!a || typeof a.score !== "number") {
      log?.info?.("TRIAGE", "Jev returned no score — fail-open to flagship");
      return null;
    }
    return { score: a.score, levels: Object.keys(a.legend || {}).length || DIFFICULTY.criteria.length };
  } catch (e) {
    log?.info?.("TRIAGE", `Jev call failed (${e.name}) — fail-open to flagship`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {Object}   opts
 * @param {Object}   opts.body              - Request body (OpenAI/Claude/Gemini shape)
 * @param {string[]} opts.models            - Combo models, ordered cheap→expensive
 * @param {Function} opts.handleComboChat   - Existing fallback executor (injected to avoid a cycle)
 * @param {Function} opts.handleSingleModel - Passed through to handleComboChat
 * @param {Object}   opts.log
 * @param {string}   opts.comboName
 * @param {number}   [opts.comboStickyLimit]
 * @param {Object}   [opts.tuning]          - { cuts?: number[] } per-combo overrides
 * @param {string}   [opts.apiKey]          - Jev key (defaults to TYPESAFE_API_KEY env)
 */
export async function handleTriageChat({
  body, models, handleComboChat, handleSingleModel, log, comboName, comboStickyLimit, tuning, apiKey,
}) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  const key = apiKey || process.env.TYPESAFE_API_KEY;
  const run = (start) =>
    handleComboChat({
      body,
      models: list.slice(start),
      handleSingleModel,
      log,
      comboName,
      comboStrategy: "fallback",
      comboStickyLimit,
    });

  if (list.length <= 1 || !key) {
    if (!key) log?.info?.("TRIAGE", `no TYPESAFE_API_KEY — running combo "${comboName}" as plain fallback`);
    return run(0);
  }

  const jev = await askJev(extractState(body), key, log);
  if (!jev) return run(list.length - 1); // fail-open: flagship

  const k = scoreToIndex(jev.score, jev.levels, list.length, tuning?.cuts);
  log?.info?.("TRIAGE", `Combo "${comboName}" | difficulty=${jev.score.toFixed(2)}/${jev.levels - 1} → start@${k} (${list[k]})`);
  return run(k);
}

/**
 * Capability combo strategy — Jev-fit routing.
 *
 * Where triage picks by DIFFICULTY (position in a cost ladder), capability picks
 * by FIT: it builds a Jev `Choice` from each member model's profile description
 * and asks "which model is best for this request?". Strengths are a property of
 * the MODEL (settings.modelProfiles), so one description is reused across every
 * combo that includes that model.
 *
 * The chosen model is floated to the front and the rest kept as fallback, then
 * handed to handleComboChat. Fails OPEN to the first model (default best) if a
 * model lacks a profile or Jev errors.
 *
 * @param {Object}   opts.profiles - map modelId -> description string (settings.modelProfiles)
 */
export async function handleCapabilityChat({
  body, models, profiles, handleComboChat, handleSingleModel, log, comboName, comboStickyLimit, apiKey,
}) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  const key = apiKey || process.env.TYPESAFE_API_KEY;
  const run = (ordered) =>
    handleComboChat({
      body, models: ordered, handleSingleModel, log, comboName,
      comboStrategy: "fallback", comboStickyLimit,
    });

  // Criteria = only members that HAVE a profile. Jev needs a description per option.
  const criteria = {};
  for (const m of list) if (profiles?.[m]?.trim()) criteria[m] = profiles[m].trim();
  const described = Object.keys(criteria);

  if (list.length <= 1 || described.length < 2 || !key) {
    if (described.length < 2) log?.info?.("CAPABILITY", `Combo "${comboName}": <2 described models — plain fallback`);
    return run(list);
  }

  const { json, error } = await askJevRaw(
    { route: { type: "choice", instructions: "Which model is the best fit for the user's most recent request?", criteria } },
    extractState(body), key
  );
  const a = json?.answers?.route;
  if (error || !a?.choice) {
    log?.info?.("CAPABILITY", `Jev ${error || "no choice"} — fail-open to ${list[0]}`);
    return run(list);
  }

  // Float the pick to the front; keep the rest (original order) as fallback.
  const ordered = [a.choice, ...list.filter((m) => m !== a.choice)];
  log?.info?.("CAPABILITY", `Combo "${comboName}" | pick=${a.choice} (conf ${a.confidence?.toFixed(2)}) → order [${ordered.join(", ")}]`);
  return run(ordered);
}

/**
 * Cost-per-performance combo strategy.
 *
 * Same Jev Choice as capability (fit per model), but instead of taking argmax
 * fit, it weights each model's fit PROBABILITY by real price from 9router's
 * pricing table and picks best VALUE:
 *
 *     value[m] = probability[m] / price[m]^lambda
 *
 * lambda = cost sensitivity (0 → pure capability; 1 → full price weighting).
 * No extra Jev call — reuses the Choice's probability distribution.
 *
 * Price proxy = OUTPUT $/Mtok (dominant term in generation; input is known but
 * small). Free/unknown-priced models get a tiny epsilon so they win ties but
 * don't divide-by-zero.
 * ponytail: output-price proxy. If output length varies wildly per model, switch
 * to a blended input+expected-output estimate when you have length data.
 *
 * @param {Function} opts.getPrice - (model) => $/Mtok output, or null/0 if free/unknown
 */
export async function handleCostPerfChat({
  body, models, profiles, getPrice, lambda = 1, handleComboChat, handleSingleModel, log, comboName, comboStickyLimit, apiKey,
}) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  const key = apiKey || process.env.TYPESAFE_API_KEY;
  const run = (ordered) =>
    handleComboChat({
      body, models: ordered, handleSingleModel, log, comboName,
      comboStrategy: "fallback", comboStickyLimit,
    });

  const criteria = {};
  for (const m of list) if (profiles?.[m]?.trim()) criteria[m] = profiles[m].trim();
  if (list.length <= 1 || Object.keys(criteria).length < 2 || !key) {
    if (Object.keys(criteria).length < 2) log?.info?.("COSTPERF", `Combo "${comboName}": <2 described models — plain fallback`);
    return run(list);
  }

  const { json, error } = await askJevRaw(
    { route: { type: "choice", instructions: "Which model is the best fit for the user's most recent request?", criteria } },
    extractState(body), key
  );
  const probs = json?.answers?.route?.probabilities;
  if (error || !probs) {
    log?.info?.("COSTPERF", `Jev ${error || "no probabilities"} — fail-open to ${list[0]}`);
    return run(list);
  }

  const EPS = 0.01; // free/unknown price floor (¢/Mtok) so value stays finite
  const scored = Object.keys(criteria)
    .map((m) => {
      const price = Math.max(getPrice?.(m) || 0, EPS);
      const value = (probs[m] ?? 0) / Math.pow(price, lambda);
      return { m, p: probs[m] ?? 0, price, value };
    })
    .sort((x, y) => y.value - x.value);

  const pick = scored[0].m;
  const ordered = [pick, ...list.filter((m) => m !== pick)];
  const tbl = scored.map((s) => `${s.m} p=${s.p.toFixed(2)} $${s.price} v=${s.value.toFixed(3)}`).join(" | ");
  log?.info?.("COSTPERF", `Combo "${comboName}" | λ=${lambda} pick=${pick} → [${ordered.join(", ")}] :: ${tbl}`);
  return run(ordered);
}
