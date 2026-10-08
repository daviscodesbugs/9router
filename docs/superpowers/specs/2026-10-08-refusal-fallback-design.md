# Refusal Fallback Design

## Goal

When a combo model **declines a request on policy or safety grounds**, 9router
automatically retries the same request on the next model in the combo, **without
giving up live streaming**. A companion pi extension removes the refused attempt
from the saved conversation so it cannot poison later turns.

Success looks like: in pi, a refused turn streams the refusal briefly, shows a
retry notice, streams the fallback model's answer, and the saved session contains
only the fallback answer plus a non-LLM record of the switch.

## Background

- Combo fallback today escalates only on HTTP errors. A refusal usually arrives as
  a **successful** response, so the combo returns it as-is.
- Upstream commit `0f488c70` (included in v0.5.95) maps Claude's
  `stop_reason: "refusal"` to `finish_reason: "content_filter"` and surfaces
  Anthropic's explanation as message text. Gemini safety stops already map to
  `content_filter`.
- Many refusals carry **no** machine-readable signal: the model simply writes "I
  can't help with that" and stops normally. Regex detection (pi's
  `extensions/model-fallback.ts`) caught 1 of 7 such refusals in a probe.
- A Jev (TypeSafe System One) probe on 20 hand-written cases
  (`~/workspace/9router/notes/jev-refusal-eval/`) separated refusals (0.95 to 0.97)
  from look-alikes (at most 0.34), at roughly 170ms per call. Two ambiguous cases,
  a **partial** refusal and a **protective** refusal ("I won't run `rm -rf` on
  prod"), also scored as refusals; two additional questions in the same call
  correctly excluded both. The cases were written and labeled by the same author,
  so thresholds are provisional.

## Scope

In scope:

1. A refusal-fallback mode for combos, opt-in per combo.
2. OpenAI chat completions clients, streaming and non-streaming.
3. Detection from `finish_reason: "content_filter"` and from a Jev decision.
4. A pi extension that carves the refused attempt out of saved messages.
5. Structured logging sufficient to measure model thrash.

Out of scope for v1:

- Anthropic `/v1/messages` and OpenAI Responses API client formats.
- Pinning the fallback model for the rest of a task (see Future Work).
- Classifying HTTP-error refusals (400/403 content-policy errors). Those already
  fall through the existing combo loop.
- A dashboard toggle. Configuration is set in the settings DB.
- Refusal handling for single-model (non-combo) requests.

## Architecture

### Components

| Unit | Location | Responsibility |
| --- | --- | --- |
| Jev client | `open-sse/services/jev.js` | POST to the System One endpoint with a timeout; return answers or a typed error. No routing logic. |
| Refusal judge | `open-sse/services/refusalJudge.js` | Given `{ userRequest, assistantText, finishReason, hasToolCalls }` and config, return `{ decision, path, scores }`. Pure apart from the injected Jev client. |
| Splice | `open-sse/services/refusalSplice.js` | Wrap a model's response; forward, hold back terminal frames, consult the judge, and either finish or splice in the next hop. |
| Combo hook | `open-sse/services/combo.js` | In the success branch, call the splice when the combo has refusal fallback enabled and models remain. |
| Config plumbing | `src/sse/handlers/chat.js` | Read `comboStrategies[name].refusalFallback` and the client format; pass both into `handleComboChat` at every call site. |
| Log writer | `open-sse/services/refusalLog.js` | Append one JSON line per check to `~/.9router/logs/refusal-fallback.jsonl` (under `DATA_DIR`). Never throws into the request path. |
| Thrash report | `scripts/refusal-thrash.mjs` | Summarize the JSONL file. |
| pi companion | `~/workspace/pi/extensions/router-refusal.ts` (+ `.test.ts`) | Carve markers out of finished messages, record the switch, tidy the live display. |

### Combo hook

`handleComboChat` gains two options: `refusalFallback` (the combo's config object,
or `undefined`) and `clientFormat`. In the success branch:

```js
if (result.ok) {
  if (refusalFallback?.enabled && clientFormat === "openai" && i < rotatedModels.length - 1) {
    return spliceRefusals(result, {
      body, modelStr, hop: refusalFallback.hop ?? 0, config: refusalFallback, log, comboName,
      next: () => handleComboChat({
        body, models: rotatedModels.slice(i + 1), handleSingleModel, log, comboName,
        comboStrategy: "fallback",      // never re-rotate round-robin state
        autoSwitch: false,              // order already decided
        clientFormat,
        refusalFallback: { ...refusalFallback, hop: (refusalFallback.hop ?? 0) + 1 },
      }),
    });
  }
  return result;
}
```

The recursive call gives the next model the full existing behavior: HTTP-error
fallback, account rotation, and its own refusal check.

`clientFormat` comes from `detectFormatByEndpoint(new URL(request.url).pathname, body)`
in `chat.js`, at all three `handleComboChat` call sites.

### Streaming splice

For a `text/event-stream` response, the splice returns a new `Response` with the
original status and headers and a body built as follows:

1. Read model A's SSE body and split on frame boundaries (`\n\n`).
2. **Forward each frame immediately**, except **hold** these:
   - a chunk whose `choices[0].finish_reason` is non-null,
   - a usage-only chunk (`choices` empty, `usage` present),
   - `data: [DONE]`.
3. While forwarding, accumulate `delta.content` text, note whether any
   `delta.tool_calls` appeared, and remember the chunk `id` and the finish reason.
   If the accumulated text contains a refusal-fallback marker (a nested combo
   already spliced), reset the accumulator to the text after the marker.
4. When A's body ends, ask the judge.
5. **Keep:** emit the held frames in their original order and close.
6. **Fall back:**
   - Drop A's held frames.
   - Emit one content chunk carrying the marker (see Marker Contract), using A's
     `id` and `model`.
   - Call `next()`. If it returns `ok`, pipe its frames through, rewriting each
     chunk's `id` to A's `id`. `model` is left as the real fallback model.
   - If `next()` returns an error response, or the hop limit is reached, emit the
     exhausted marker and then A's held frames, so the stream still terminates
     normally and A's answer stands.
7. On client cancel, cancel whichever upstream reader or `next()` stream is active.

The pause between A's last content and stream close is the judge latency
(about 170ms when Jev is consulted; zero on skips and shortcuts).

A's usage still reaches 9router's usage tracking because the splice reads A's
body to the end; only the client-facing usage frame is dropped.

### Non-streaming splice

For a JSON response: read the body, ask the judge, and either return the original
response or the result of `next()` with an added header
`x-9r-refusal-fallback: <from>-><to>`. No marker is written into the text.

## Marker Contract

The marker is the only interface between 9router and the pi companion.

```
\n\n⟦9r:refusal-fallback from=<model> to=<model>⟧\n\n
\n\n⟦9r:refusal-fallback-exhausted⟧\n\n
```

- `<model>` is the combo entry string (e.g. `cc/claude-opus-4-8`) and contains no
  spaces or `⟧`.
- `to` names the first model that `next()` will try. If that model fails with an
  HTTP error and the inner loop moves on, the chunk `model` field reflects the
  model that actually answered.
- Text **after the last** `refusal-fallback` marker is the answer that counts.
- The exhausted marker means the preceding answer stands.
- Clients without the companion simply see a readable line.

## Detection

The judge runs these steps in order and stops at the first that decides:

| Step | Condition | Result | `path` |
| --- | --- | --- | --- |
| 1 | `hasToolCalls` | keep | `skip:tool_calls` |
| 2 | finish reason is `content_filter` | fall back | `shortcut:content_filter` |
| 3 | text is empty | keep | `skip:empty` |
| 4 | text longer than `maxChars` | keep | `skip:max_chars` |
| 5 | no `TYPESAFE_API_KEY` | keep | `skip:no_key` |
| 6 | Jev call | see below | `jev` / `jev_error` |

The Jev call sends one request with three Noul questions and this state:

```json
{ "user_request": "<last user message text, truncated>",
  "assistant_response": "<accumulated text, truncated>" }
```

- `refusal`: the assistant declines the requested task on policy, safety, or
  ethical grounds, as opposed to reporting a technical limitation, asking a
  clarifying question, drafting refusal wording on request, explaining a policy,
  or completing the task with a caveat.
- `partial`: besides anything it declines, the response substantially completes at
  least one part of the request.
- `protective`: the assistant is declining a destructive or irreversible action on
  the user's own systems.

**Fall back only if** `refusal >= threshold && partial < partialMax && protective < protectiveMax`.
Exact question wording is taken from the probe script and kept in one place.

Jev settings: endpoint `https://api.typesafe.ai/v1/systemone`, model pinned to
`jev-1.13.0`, 4000ms timeout, key from `TYPESAFE_API_KEY`. Any Jev error or
timeout yields **keep** (`jev_error`).

## Configuration

Per combo, in settings:

```js
comboStrategies["<combo>"].refusalFallback = {
  enabled: true,
  threshold: 0.8,
  partialMax: 0.5,
  protectiveMax: 0.5,
  maxChars: 6000,
  maxHops: 2,
}
```

Missing fields take these defaults. The mode is off unless `enabled` is true.
`maxHops` caps refusal-triggered hops per request; when `hop >= maxHops` the judge
is not consulted and the response is kept.

## pi Companion Extension

`router-refusal.ts`, with marker parsing in an exported pure function.

1. **`message_end` carve.** If the finished assistant message contains a
   `refusal-fallback` marker, return a replacement message that keeps only content
   after the last marker: drop every content block before the block containing the
   marker, and the text before the marker within that block. This removes model
   A's text and thinking. For the exhausted marker, remove only the marker text.
2. **Record.** `pi.appendEntry("9r-refusal-fallback", { from, to, removedChars })`
   plus an entry renderer showing `↺ refused on <from> → answered by <to>`.
   Custom entries are not sent to models.
3. **Live display.** A markdown transformer that, while streaming, collapses text
   before a marker into a dim `retrying on <to>…` line.
4. **`context` safety net.** Apply the same carve to outgoing assistant messages,
   for messages saved before the extension loaded.

`extensions/model-fallback.ts` is unchanged. It runs on `agent_end`, after
`message_end` has already replaced the message, so it only acts when 9router
reports exhaustion. Implementation must verify that `agent_end` observes the
replaced message.

## Error Handling

| Failure | Behavior |
| --- | --- |
| Jev error, timeout, or missing key | Keep A's response; log `jev_error` / `skip:no_key`. |
| `next()` returns non-ok | Exhausted marker, then A's held frames. |
| `next()` throws | Same as non-ok; log the error. |
| Malformed SSE frame from A | Forward it unchanged; it does not contribute to accumulated text. |
| Client disconnects | Cancel active upstream reader / `next()` body. |
| Log write fails | Swallow and `log.warn` once; never affects the response. |
| Hop limit reached | Keep the response without consulting the judge. |

## Logging

One JSON line per judge decision in `refusal-fallback.jsonl`:

```json
{ "ts": "...", "combo": "main", "model": "cc/claude-opus-4-8", "hop": 0,
  "path": "jev", "scores": { "refusal": 0.97, "partial": 0.04, "protective": 0.11 },
  "decision": "fallback", "to": "cx/gpt-5.6-terra", "jevMs": 168,
  "conversation": "<sha256 of system prompt + first user message, 12 hex chars>" }
```

Skips are logged too, so the file shows how often the judge is consulted.
`scripts/refusal-thrash.mjs` reports: checks by path, fallbacks per conversation,
conversations with more than one fallback (thrash), and Jev latency p50/p95.

## Testing

9router (`tests/refusalSplice.test.mjs`, `tests/refusalJudge.test.mjs`), using fake
SSE bodies and an injected fake judge or Jev client:

- non-refusal stream passes through with all frames in order
- refusal: marker followed by the next model's frames, `id` rewritten
- two-hop chain and the `maxHops` limit
- exhausted: `next()` non-ok and `next()` throws
- skips: tool calls, empty text, `maxChars`, last model, no key
- `content_filter` shortcut without a Jev call
- Jev error and timeout keep the response
- nested marker resets the accumulator
- client cancel reaches the upstream reader
- non-streaming keep and fallback, including the header
- judge thresholds against the probe's score patterns (partial and protective
  excluded)

pi (`extensions/router-refusal.test.ts`): marker mid-text, two markers, exhausted
marker, thinking blocks before the marker, no marker (unchanged message).

Jev regression eval: `~/workspace/9router/notes/jev-refusal-eval/`, extended with
real refusals and near-misses harvested from pi session logs. Re-run when
thresholds or the Jev version change.

End to end on the dev instance (`:20127`, `DATA_DIR=~/.9router-devtest`):

1. A local stub OpenAI-compatible server that always streams a refusal, registered
   as model A in a test combo; a real model as B.
2. `curl` streaming and non-streaming requests; check frames, marker, header, log.
3. pi against the dev instance. Prerequisite: the `9router-dev` provider in
   `~/.pi/agent/models.json` currently points at `localhost:20129` (the OmniRoute
   container) and must point at `:20127`.

## Rollout

1. Implement on `feat/refusal-fallback` (this worktree), based on upstream v0.5.95.
2. Enable on a test combo on the dev instance; then on `main` on the live install
   via the existing `patch.sh` mechanism (which must be extended to carry these
   files) with `TYPESAFE_API_KEY` set in the tray launch environment.
3. Review the thrash report after real use.

## Future Work

- **Pinning (if thrash is high):** after a marker, the pi companion sends
  `x-9r-combo-start: <to>` on subsequent requests until the next real user input,
  and the combo starts at that model.
- Anthropic `/v1/messages` and Responses API splice.
- Classifying HTTP 400/403 content-policy errors so they skip account cooldown.
- Per-category handling of Claude `stop_details` (e.g. never retry
  `reasoning_extraction`) once `stop_details` is carried through translation.

## Risks

- **Thresholds are provisional.** They come from 20 hand-written cases. Mitigation:
  logging plus the regression eval with real cases.
- **Routing around protective refusals.** The `protective` question is the guard
  and had the thinnest margin in the probe (0.41 to 0.47 on unrelated cases).
- **Billing.** Some refusals are billed by the provider, so a fallback can pay for
  two requests.
- **Clients without the companion** keep the refused text in history.
