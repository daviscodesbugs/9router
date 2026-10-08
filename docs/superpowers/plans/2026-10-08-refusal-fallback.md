# Refusal Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a combo model declines on policy/safety grounds, 9router splices the next combo model into the same live stream behind a marker, and a pi extension carves the refused attempt out of saved history.

**Architecture:** A pure judge (content_filter shortcut, else a three-Noul Jev call) decides keep/fallback. A splice wraps a successful combo response: it forwards frames live, holds terminal frames, asks the judge at stream end, and either releases them or emits a marker and pipes a recursive `handleComboChat` over the remaining models. The pi extension rewrites the finished message at `message_end`.

**Tech Stack:** Node ESM, Web Streams (`Response`, `ReadableStream`), vitest (9router `tests/`), `node:test` + `just test` (pi), TypeSafe System One HTTP API.

**Spec:** `docs/superpowers/specs/2026-10-08-refusal-fallback-design.md`

## Global Constraints

- Worktree: `~/workspace/9router-refusal-fallback`, branch `feat/refusal-fallback`, based on upstream v0.5.95 (`a99cf572`).
- 9router code style: 2-space indent, ESM, existing `log.info/warn(TAG, msg, data)` logger passed in as `log`.
- 9router tests: `tests/unit/<name>.test.js`, vitest, run from `tests/`: `cd tests && npx vitest run unit/<name>.test.js`.
- pi code style: tabs, TypeScript, `node:test` + `node:assert`; run `just test router-refusal` from `~/workspace/pi`.
- Jev: endpoint `https://api.typesafe.ai/v1/systemone`, model `jev-1.13.0`, timeout `4000` ms, key `process.env.TYPESAFE_API_KEY`.
- Config defaults: `threshold 0.8`, `partialMax 0.5`, `protectiveMax 0.5`, `maxChars 6000`, `maxHops 2`, `enabled false`.
- Marker strings, exact: `\n\n⟦9r:refusal-fallback from=<from> to=<to>⟧\n\n` and `\n\n⟦9r:refusal-fallback-exhausted⟧\n\n`.
- Non-streaming fallback header: `x-9r-refusal-fallback: <from>-><to>`.
- Log file: `<getDataDir()>/logs/refusal-fallback.jsonl`; conversation fingerprint = first 12 hex chars of sha256(system prompt + "\n" + first user message text).
- Every failure in judge, Jev, or logging keeps model A's response. Nothing in this feature may turn a successful request into an error.
- Commit only files this plan names; the main `9router-dev` checkout and the pi repo have unrelated uncommitted work.

**Spec deviation (deliberate):** the spec says `clientFormat` comes from `detectFormatByEndpoint`, but that function returns `null` for plain `/v1/chat/completions`. Task 6 instead adds `isOpenAIChatRequest(pathname, body)`: true when `pathname` includes `/chat/completions` and `body.input` is not an array.

## Review Focus

1. **SSE frames split across network chunks**, including `\r\n` line endings: a frame cut mid-JSON must be reassembled, never forwarded half-parsed or dropped. Test in Task 4 (`reassembles frames split across reads`).
2. **Upstream stream that ends without a finish chunk or `[DONE]`** (stall, truncation): the splice must still judge what it has and close the client stream. Test in Task 4 (`closes when upstream ends without terminal frames`).
3. **Fallback model's own `[DONE]` and usage**: the client must see exactly one `[DONE]`, at the end. Test in Task 4 (`emits exactly one DONE after a splice`).
4. **Reasoning-only answers** (`delta.reasoning_content`, empty `content`): must be `skip:empty`, no Jev call. Test in Task 2 (`reasoning-only answer is skip:empty`) and Task 4 accumulates only `delta.content`.
5. **User messages with content-part arrays or huge text** (images, pasted files): `lastUserText` takes text parts only and truncates to 4000 chars. Test in Task 2 (`lastUserText handles parts and truncates`).

---

### Task 1: Jev client

**Files:**
- Create: `open-sse/services/jev.js`
- Test: `tests/unit/jev-client.test.js`

**Interfaces:**
- Produces: `JEV_ENDPOINT`, `JEV_MODEL` constants; `askJev({ state, questions, apiKey, model = JEV_MODEL, timeoutMs = 4000, fetchImpl = fetch }) -> Promise<{ answers: object, ms: number } | { error: string, ms: number }>`. Never throws.

- [ ] **Step 1: Install test deps and record the baseline** — `cd tests && npm install`, then `npx vitest run 2>&1 | tail -5` on the untouched branch; save the failing-test count to compare against in Task 6.
- [ ] **Step 2: Write failing tests**

```js
it("posts model, state, questions with bearer auth", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ answers: { q: { noul: 0.9 } } })); };
  const r = await askJev({ state: { a: 1 }, questions: { q: { type: "noul", instructions: "x" } }, apiKey: "k", fetchImpl });
  expect(seen.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(seen.init.headers.authorization).toBe("Bearer k");
  expect(JSON.parse(seen.init.body)).toMatchObject({ model: "jev-1.13.0", state: { a: 1 } });
  expect(r.answers.q.noul).toBe(0.9);
});
it("returns {error:'HTTP 500'} on non-ok", ...);          // r.error === "HTTP 500"
it("returns {error:'AbortError'} on timeout", ...);       // fetchImpl never resolves until signal aborts; timeoutMs: 20
it("returns {error} when fetch throws", ...);             // r.error is a non-empty string
```

- [ ] **Step 3: Run** `cd tests && npx vitest run unit/jev-client.test.js` — expect FAIL (module not found).
- [ ] **Step 4: Implement** `askJev` with an `AbortController` timer cleared in `finally`.
- [ ] **Step 5: Run** the same command — expect PASS.
- [ ] **Step 6: Commit** `git add open-sse/services/jev.js tests/unit/jev-client.test.js && git commit -m "feat(jev): add fail-soft System One client"`

---

### Task 2: Refusal judge

**Files:**
- Create: `open-sse/services/refusalJudge.js`
- Test: `tests/unit/refusal-judge.test.js`

**Interfaces:**
- Consumes: `askJev` (Task 1).
- Produces:
  - `REFUSAL_DEFAULTS` (Global Constraints values).
  - `REFUSAL_QUESTIONS` — `{ refusal, partial, protective }`, each `{ type: "noul", instructions }`, wording copied verbatim from `~/workspace/9router/notes/jev-refusal-eval/eval.py` (`refusal`, `partial`, `protective`).
  - `resolveRefusalConfig(raw?: object) -> config` (defaults merged; `enabled` true only if `raw.enabled === true`).
  - `lastUserText(body) -> string` — last `role:"user"` message; string content or concatenated `type:"text"` parts; first 4000 chars.
  - `judgeRefusal({ userRequest, assistantText, finishReason, hasToolCalls }, config, { ask = askJev, apiKey = process.env.TYPESAFE_API_KEY } = {}) -> Promise<{ decision: "keep"|"fallback", path: string, scores?: {refusal,partial,protective}, jevMs?: number }>`

- [ ] **Step 1: Write failing tests** — one per spec Detection row plus gates. `ask` is a fake returning `{ answers: { refusal:{noul}, partial:{noul}, protective:{noul} }, ms: 5 }`.

```js
const cfg = resolveRefusalConfig({ enabled: true });
const fake = (r, p, pr) => async () => ({ answers: { refusal: { noul: r }, partial: { noul: p }, protective: { noul: pr } }, ms: 5 });
it("tool calls → keep skip:tool_calls", ...);                    // even with finishReason content_filter
it("content_filter → fallback shortcut, no Jev call", ...);      // ask throws if called
it("empty text → keep skip:empty", ...);
it("reasoning-only answer is skip:empty", ...);                  // assistantText "" with finishReason "stop"
it("over maxChars → keep skip:max_chars", ...);                  // 6001 chars
it("no key → keep skip:no_key", ...);                            // apiKey: undefined
it("clear refusal → fallback path jev with scores", ...);        // fake(0.97, 0.04, 0.11)
it("partial refusal → keep", ...);                               // fake(0.92, 0.95, 0.77)
it("protective refusal → keep", ...);                            // fake(0.85, 0.16, 0.97)
it("non-refusal → keep", ...);                                   // fake(0.34, 0.90, 0.34)
it("Jev error → keep jev_error", ...);                           // ask returns { error: "HTTP 500", ms: 3 }
it("sends user_request and assistant_response as state", ...);
it("lastUserText handles parts and truncates", ...);             // parts [{type:"image_url"},{type:"text",text:"a"},{type:"text",text:"b"}] → "ab"; 5000-char text → length 4000
```

- [ ] **Step 2: Run** `cd tests && npx vitest run unit/refusal-judge.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the module; check order exactly as the spec's Detection table; the fallback condition is `refusal >= threshold && partial < partialMax && protective < protectiveMax`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(refusal): add Jev-backed refusal judge`

---

### Task 3: Refusal log and thrash report

**Files:**
- Create: `open-sse/services/refusalLog.js`, `scripts/refusal-thrash.mjs`
- Test: `tests/unit/refusal-log.test.js`

**Interfaces:**
- Produces:
  - `conversationFingerprint(body) -> string` (12 hex; see Global Constraints; system prompt = first `role:"system"` message text, else "").
  - `logRefusalCheck(entry: object, { file?: string } = {}) -> void` — appends `JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"`, creating the directory; default file from `getDataDir()` (`@/lib/dataDir.js`). Swallows errors and `console.warn`s once per process.
  - `summarize(entries: object[]) -> { checks: number, byPath: Record<string,number>, fallbacks: number, conversationsWithFallback: number, thrashConversations: number, jevMsP50: number|null, jevMsP95: number|null }` exported from the script. Thrash = a conversation with ≥2 `decision:"fallback"` entries.
  - CLI: `node scripts/refusal-thrash.mjs [file]` prints the summary as JSON; default file as above. Guard with `import.meta.url === pathToFileURL(process.argv[1]).href`.

- [ ] **Step 1: Write failing tests**

```js
it("fingerprint is stable across turns of one conversation", ...); // same system+first user, different later messages → equal, length 12
it("fingerprint differs for different first user message", ...);
it("appends one JSON line per call with ts", ...);                 // tmp file; two calls → two parseable lines
it("never throws when the path is unwritable", ...);               // file: "/proc/nope/x.jsonl"
it("summarize counts paths, fallbacks and thrash", ...);
// entries: 3 for conv A (2 fallback), 1 fallback conv B, 1 skip:tool_calls; jevMs [100,200,300]
// expect fallbacks 3, conversationsWithFallback 2, thrashConversations 1, byPath["skip:tool_calls"] 1, jevMsP50 200
```

- [ ] **Step 2: Run** `cd tests && npx vitest run unit/refusal-log.test.js` — expect FAIL.
- [ ] **Step 3: Implement** both files (`node:crypto` `createHash("sha256")`, `fs.mkdirSync(..., { recursive: true })`, `fs.appendFileSync`; nearest-rank percentiles).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(refusal): add check log and thrash report`

---

### Task 4: Streaming splice

**Files:**
- Create: `open-sse/services/refusalSplice.js`
- Test: `tests/unit/refusal-splice-stream.test.js`

**Interfaces:**
- Consumes: `judgeRefusal`, `resolveRefusalConfig`, `lastUserText` (Task 2); `logRefusalCheck`, `conversationFingerprint` (Task 3).
- Produces:
  - `fallbackMarker(from: string, to: string) -> string`, `EXHAUSTED_MARKER: string`, `MARKER_RE: RegExp` (matches the fallback marker, capture groups `from`, `to`).
  - `spliceRefusals(response: Response, opts) -> Promise<Response>` where `opts = { body, modelStr, nextModel, hop, config, log, comboName, next: () => Promise<Response>, judge = judgeRefusal, logCheck = logRefusalCheck }`.
  - Behavior: if `hop >= config.maxHops` return `response` untouched. If the response content-type includes `text/event-stream`, return a new `Response` immediately (same status/headers) whose body follows the spec's Streaming splice steps 1–7. Non-streaming is Task 5 (until then, return `response` untouched).
  - Every judge outcome calls `logCheck({ combo: comboName, model: modelStr, hop, path, scores, jevMs, decision, to?, conversation })`.

Test helpers (in the test file): `sse(frames: object[], { done = true, chunkSize })` builds a `Response` with `content-type: text/event-stream` whose body emits the frames as `data: <json>\n\n` (plus `data: [DONE]\n\n`), optionally re-chunked every `chunkSize` bytes; `readAll(res) -> string`; `frames(text) -> parsed data payloads`. Judge is injected: `judge: async () => ({ decision: "keep"|"fallback", path: "jev" })`. `logCheck` is a spy.

- [ ] **Step 1: Write failing tests**

```js
it("passes a non-refusal through with all frames in order", ...);   // output payloads deep-equal input payloads, then [DONE]
it("forwards content frames before the judge resolves", ...);       // judge awaits a gate; first content frame is readable while gate is closed
it("splices: marker then next model frames with A's id", ...);
// A: id "a1", content "I can't", finish "stop"; B: id "b1", content "Sure", finish "stop"
// expect contents ["I can't", fallbackMarker("cc/a","cx/b"), "Sure"], every B chunk id === "a1", A's finish chunk absent, B's finish present
it("emits exactly one DONE after a splice", ...);
it("exhausted when next() is non-ok: marker then A's held frames", ...);  // next → Response 503 JSON
it("exhausted when next() throws", ...);
it("keeps without judging at maxHops", ...);                         // hop 2, judge throws if called
it("keeps when upstream returned tool calls", ...);                  // judge receives hasToolCalls true
it("judges only text after an inner marker", ...);                   // A content contains fallbackMarker(...) + "real"; judge receives assistantText "real"
it("reassembles frames split across reads", ...);                    // chunkSize 7, plus a "\r\n\r\n"-terminated variant
it("closes when upstream ends without terminal frames", ...);        // done:false, no finish chunk; stream ends; output has the content
it("cancel propagates to the active upstream", ...);                // cancel spy on A's body fires when cancelled mid-A; on B's body when cancelled after the splice
it("logs one check per hop with decision and to", ...);
```

- [ ] **Step 2: Run** `cd tests && npx vitest run unit/refusal-splice-stream.test.js` — expect FAIL.
- [ ] **Step 3: Implement.** Parse with a `TextDecoder` stream buffer split on `/\r?\n\r?\n/`; keep the raw frame text for forwarding (re-emit with `\n\n`). A frame is held if its JSON has non-null `choices[0].finish_reason`, or empty `choices` with `usage`, or is `[DONE]`. Unparseable frames are forwarded and ignored for accumulation. On fallback, B's response goes through the same frame parser, rewriting `id` on parsed chunks; B's frames are forwarded as-is otherwise (B's response from `next()` is already spliced by the recursive combo call, so no second judging here). The synthetic marker chunk is `{ id, object: "chat.completion.chunk", created, model: modelStr, choices: [{ index: 0, delta: { content: marker }, finish_reason: null }] }` using A's `id`/`created`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(refusal): splice next combo model into a live stream`

---

### Task 5: Non-streaming splice

**Files:**
- Modify: `open-sse/services/refusalSplice.js`
- Test: `tests/unit/refusal-splice-json.test.js`

**Interfaces:**
- Consumes/extends: `spliceRefusals` (Task 4) for responses whose content-type is not `text/event-stream`.
- Behavior: read the JSON body; judge with `choices[0].message.content` (string or text parts), `finish_reason`, and `tool_calls` presence. Keep → new `Response` with the same body text, status, headers. Fallback → `await next()`; if ok, return it with header `x-9r-refusal-fallback: <modelStr>-><nextModel>` added (copy headers into a new `Response`); if not ok or it throws, return A's body as on keep. Unparseable JSON → keep.

- [ ] **Step 1: Write failing tests** — `keep returns identical body`, `fallback returns next body with header "cc/a->cx/b"`, `next non-ok returns A's body`, `next throws returns A's body`, `invalid JSON body is returned unchanged`, `no marker text in fallback body`.
- [ ] **Step 2: Run** `cd tests && npx vitest run unit/refusal-splice-json.test.js` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both splice test files — expect PASS.
- [ ] **Step 5: Commit** `feat(refusal): non-streaming refusal fallback`

---

### Task 6: Combo hook and chat plumbing

**Files:**
- Modify: `open-sse/services/combo.js` (`handleComboChat` signature at line 280 and success branch at lines 308–311)
- Modify: `src/sse/handlers/chat.js` (the three `handleComboChat({...})` calls near lines 128, 148, 205)
- Modify: `open-sse/services/refusalSplice.js` (add `isOpenAIChatRequest`)
- Test: `tests/unit/combo-refusal-fallback.test.js`

**Interfaces:**
- Consumes: `spliceRefusals`, `resolveRefusalConfig`.
- Produces:
  - `isOpenAIChatRequest(pathname: string, body) -> boolean` (see Spec deviation).
  - `handleComboChat({ ..., refusalFallback = undefined, clientFormat = null })`. The success branch uses the code block in the spec's "Combo hook" section, with `nextModel: rotatedModels[i + 1]` added to the splice options and `config: resolveRefusalConfig(refusalFallback)`.
  - In `chat.js`, each call site passes `refusalFallback: comboStrategies[modelStr]?.refusalFallback` (use `chatSettings` in the nested site) and `clientFormat: request?.url && isOpenAIChatRequest(new URL(request.url).pathname, body) ? "openai" : null`. The capacity-adapter call site (single model) passes neither.

- [ ] **Step 1: Write failing tests.** Fake `handleSingleModel(body, model)` returns SSE `Response`s per model; refusals use `finish_reason: "content_filter"` so no Jev key is needed. `process.env.DATA_DIR` = a tmp dir; `log` = `{ info(){}, warn(){} }`.

```js
it("disabled config returns model A as before", ...);              // refusalFallback undefined → A's frames only
it("enabled: A content_filter → marker + B", ...);                 // models ["p/a","p/b"]; output contains fallbackMarker("p/a","p/b") and B content
it("non-openai clientFormat is untouched", ...);                   // clientFormat null → A's frames only
it("last model is never wrapped", ...);                            // models ["p/a"] → identical
it("B HTTP error falls through to C via the inner loop", ...);     // B returns 500, C succeeds → output has marker(to=p/b) then C content
it("round-robin rotation is not advanced by the retry", ...);      // comboStrategy "round-robin": second request starts where it would without fallback (compare getRotatedModels order)
it("isOpenAIChatRequest", ...);                                    // "/v1/chat/completions",{} → true; "/v1/messages" → false; chat path with input[] → false
```

- [ ] **Step 2: Run** `cd tests && npx vitest run unit/combo-refusal-fallback.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the combo and chat changes.
- [ ] **Step 4: Run** the whole suite `cd tests && npx vitest run` — expect the new tests PASS and the failing count no higher than the Task 1 baseline.
- [ ] **Step 5: Commit** `feat(combo): opt-in refusal fallback per combo`

---

### Task 7: pi companion extension

**Files:**
- Create: `~/workspace/pi/extensions/router-refusal.ts`
- Test: `~/workspace/pi/extensions/router-refusal.test.ts`
- Symlink: `~/.pi/agent/extensions/router-refusal.ts -> ~/workspace/pi/extensions/router-refusal.ts`

**Interfaces:**
- Consumes: the marker strings (Global Constraints).
- Produces (exported for tests):
  - `parseMarkers(text: string) -> { fallbacks: { from: string, to: string, index: number, length: number }[], exhausted: { index: number, length: number }[] }`
  - `carveMessage(msg: AgentMessage) -> { message: AgentMessage, record?: { from: string, to: string, removedChars: number } } | null` — `null` when no marker. Fallback: drop content blocks before the block containing the last fallback marker and the text up to and including that marker; strip leading whitespace of the kept text. Exhausted only: remove the marker text, keep everything else, no record.
- Wiring: `message_end` → `carveMessage`; when non-null return `{ message }` and, if `record`, `pi.appendEntry("9r-refusal-fallback", record)`. `registerEntryRenderer("9r-refusal-fallback", ...)` renders dim `↺ refused on <from> → answered by <to>`. `registerMarkdownTransformer` (assistant, `isStreaming`) replaces text up to the last fallback marker with `_retrying on <to>…_\n\n`. `context` → apply `carveMessage` to assistant messages, return `{ messages }` only if any changed.

- [ ] **Step 1: Write failing tests**

```ts
it("carves text before a marker in the same block", ...);   // "I can't" + marker + "Sure" → content [{text:"Sure"}], record {from,to,removedChars>0}
it("keeps only after the last of two markers", ...);
it("drops thinking blocks before the marker block", ...);   // [{type:"thinking"},{type:"text",text:"no"+marker+"yes"}] → [{type:"text",text:"yes"}]
it("exhausted marker is stripped, refusal kept, no record", ...);
it("returns null without a marker", ...);
it("parseMarkers extracts from/to", ...);
```

- [ ] **Step 2: Run** `cd ~/workspace/pi && just test router-refusal` — expect FAIL.
- [ ] **Step 3: Implement** the extension (pattern: `extensions/model-fallback.ts`).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Verify ordering assumption.** Read the pi agent loop source (`grep -rn "message_end" $(npm root -g)/@earendil-works/pi-coding-agent/dist | head`) and confirm `agent_end`'s `event.messages` contains the `message_end` replacement. Record the result as a comment in `router-refusal.ts`. If it does not, add to `router-refusal.ts` an `agent_end` note and stop to report it before Task 8.
- [ ] **Step 6: Symlink and commit** (pi repo): `ln -s ~/workspace/pi/extensions/router-refusal.ts ~/.pi/agent/extensions/router-refusal.ts && cd ~/workspace/pi && git add extensions/router-refusal.ts extensions/router-refusal.test.ts && git commit -m "feat(router-refusal): carve 9router refusal-fallback splices from history"`

---

### Task 8: End-to-end on the dev instance

**Files:**
- Create: `scripts/refusal-stub-server.mjs` (9router worktree)
- Modify: `~/workspace/9router/notes/jev-refusal-eval/eval.py` (add harvested cases)

**Interfaces:**
- Produces: `node scripts/refusal-stub-server.mjs --port 20199 --mode refuse|answer` — minimal OpenAI-compatible `/v1/chat/completions` (streaming and JSON) and `/v1/models`, returning a fixed refusal text ("I'm sorry, but I can't help with that.") with `finish_reason: "stop"` or a fixed answer.

- [ ] **Step 1: Write the stub server** and check `curl -sN localhost:20199/v1/chat/completions -d '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}'` prints SSE frames ending in `data: [DONE]`.
- [ ] **Step 2: Start dev 9router** from the worktree: `npm install && DATA_DIR=$HOME/.9router-devtest TYPESAFE_API_KEY="$(pass show typesafe/api_key)" npm run dev` (port 20127). In its dashboard add an openai-compatible provider for `http://localhost:20199/v1` and a combo `refusal-test` = [stub model, a real cheap model]; set `comboStrategies["refusal-test"].refusalFallback = { enabled: true }` in `~/.9router-devtest` settings.
- [ ] **Step 3: Verify streaming** — `curl -sN localhost:20127/v1/chat/completions` with `model: "refusal-test", stream: true`: expect the refusal text, then the fallback marker naming the stub and the real model, then the real model's answer, then one `[DONE]`. Expect a `decision:"fallback"`, `path:"jev"` line in `~/.9router-devtest/logs/refusal-fallback.jsonl`.
- [ ] **Step 4: Verify non-streaming** — same with `stream: false`: response header `x-9r-refusal-fallback`, body from the real model, no marker.
- [ ] **Step 5: Verify keep path** — restart the stub with `--mode answer`; expect the stub answer, no marker, a `decision:"keep"` log line.
- [ ] **Step 6: Verify in pi** — ask Davis before editing `~/.pi/agent/models.json`: the `9router-dev` provider `baseUrl` must change from `http://localhost:20129/v1` to `http://localhost:20127/v1`, with a model id `refusal-test`. Then run a pi turn on `9router-dev/refusal-test`; expect the live retry line, and the session JSONL's final assistant message contains only the fallback answer plus a `9r-refusal-fallback` custom entry.
- [ ] **Step 7: Thrash report** — `node scripts/refusal-thrash.mjs ~/.9router-devtest/logs/refusal-fallback.jsonl` prints a summary with `fallbacks ≥ 1`.
- [ ] **Step 8: Extend the Jev eval** with real cases: harvest assistant messages from `~/.pi/agent/sessions/**/*.jsonl` whose `stopReason` is `error` with a policy `errorMessage`, plus short assistant texts matching "can't|cannot|won't|unable" that are not refusals; label them, add to `CASES`, run `TYPESAFE_API_KEY="$(pass show typesafe/api_key)" python3 eval.py`, and report whether the 0.8/0.5/0.5 gate still separates them. Commit in `~/workspace/9router` (notes only).
- [ ] **Step 9: Commit** the stub server: `feat(refusal): add stub server for end-to-end checks`

---

### Task 9: Carry the patch to the live install

**Files:**
- Modify: `~/workspace/9router/patch.sh`, `~/workspace/9router/patches/` (new `refusal-fallback/` directory), `~/workspace/9router/README.md`

**Interfaces:**
- Consumes: commits from Tasks 1–6 on `feat/refusal-fallback`.

- [ ] **Step 1: Export the patch** — `cd ~/workspace/9router-refusal-fallback && git format-patch a99cf572..HEAD -- open-sse src scripts -o ~/workspace/9router/patches/refusal-fallback/` (exclude docs).
- [ ] **Step 2: Teach `patch.sh`** to apply `patches/refusal-fallback/*.patch` with `git am` inside the build container after the clone, failing loudly naming the patch on conflict, alongside the existing soft-failover step; write `.refusal-fallback-patched` with the tag.
- [ ] **Step 3: Dry-run** the build (`./patch.sh 0.5.95` with the final swap guarded behind a `--build-only` flag added in Step 2) and confirm `app/` builds.
- [ ] **Step 4: Document** in `README.md`: the patch, the per-combo setting, and that the tray launch needs `TYPESAFE_API_KEY` in its environment.
- [ ] **Step 5: Stop and ask Davis** before running `patch.sh` without `--build-only` (it replaces the live global install) and before enabling `refusalFallback` on `main`.
- [ ] **Step 6: Commit** in `~/workspace/9router`: `feat(patch): carry refusal-fallback onto the live install`
