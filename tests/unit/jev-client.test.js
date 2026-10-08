import { describe, expect, it } from "vitest";
import { askJev, JEV_ENDPOINT, JEV_MODEL } from "../../open-sse/services/jev.js";

describe("jev-client", () => {
  it("exports JEV_ENDPOINT and JEV_MODEL", () => {
    expect(JEV_ENDPOINT).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JEV_MODEL).toBe("jev-1.13.0");
  });

  it("posts model, state, questions with bearer auth", async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ answers: { q: { noul: 0.9 } } }));
    };
    const r = await askJev({
      state: { a: 1 },
      questions: { q: { type: "noul", instructions: "x" } },
      apiKey: "k",
      fetchImpl,
    });
    expect(seen.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen.init.headers.authorization).toBe("Bearer k");
    expect(JSON.parse(seen.init.body)).toMatchObject({ model: "jev-1.13.0", state: { a: 1 } });
    expect(r.answers.q.noul).toBe(0.9);
    expect(typeof r.ms).toBe("number");
  });

  it("returns {error:'HTTP 500'} on non-ok", async () => {
    const fetchImpl = async () => new Response("err", { status: 500 });
    const r = await askJev({ state: {}, questions: {}, apiKey: "k", fetchImpl });
    expect(r.error).toBe("HTTP 500");
    expect(typeof r.ms).toBe("number");
  });

  it("returns {error:'AbortError'} on timeout", async () => {
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("AbortError");
          e.name = "AbortError";
          reject(e);
        });
      });
    const r = await askJev({ state: {}, questions: {}, apiKey: "k", fetchImpl, timeoutMs: 20 });
    expect(r.error).toBe("AbortError");
    expect(typeof r.ms).toBe("number");
  });

  it("returns {error} when fetch throws", async () => {
    const fetchImpl = async () => { throw new Error("network failure"); };
    const r = await askJev({ state: {}, questions: {}, apiKey: "k", fetchImpl });
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
    expect(typeof r.ms).toBe("number");
  });
});
