export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";

/**
 * Fail-soft client for TypeSafe's Jev "System One" decision API.
 * Never throws; always resolves to { answers, ms } or { error, ms }.
 */
export async function askJev({
  state,
  questions,
  apiKey,
  model = JEV_MODEL,
  timeoutMs = 4000,
  fetchImpl = fetch,
}) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, state, questions }),
      signal: ac.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, ms: Date.now() - t0 };
    const json = await res.json();
    return { answers: json.answers, ms: Date.now() - t0 };
  } catch (e) {
    return { error: e.name === "AbortError" ? "AbortError" : (e.message || String(e)), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}
