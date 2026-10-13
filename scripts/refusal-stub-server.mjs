#!/usr/bin/env node
// Minimal OpenAI-compatible stub for end-to-end refusal-fallback checks.
// --mode refuse  → fixed refusal text, finish_reason "stop"
// --mode answer  → fixed helpful answer, finish_reason "stop"
// Serves /v1/chat/completions (streaming + JSON) and /v1/models.
import http from "node:http";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const port = Number(arg("--port", "20199"));
const mode = arg("--mode", "refuse");
if (mode !== "refuse" && mode !== "answer") {
  console.error(`invalid --mode ${mode} (expected refuse|answer)`);
  process.exit(2);
}

const TEXT = mode === "refuse"
  ? "I'm sorry, but I can't help with that."
  : "Sure — here is the answer: the capital of France is Paris.";

const now = () => Math.floor(Date.now() / 1000);
const id = () => "chatcmpl-stub-" + Math.random().toString(36).slice(2, 10);

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [{ id: `stub-${mode}`, object: "model", created: now(), owned_by: "stub" }],
    }));
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    const body = await readBody(req);
    const model = body.model || `stub-${mode}`;
    const cid = id();
    const created = now();

    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      // role delta
      frame({ id: cid, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      // content in a couple of chunks
      for (const piece of [TEXT.slice(0, 10), TEXT.slice(10)]) {
        frame({ id: cid, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      }
      // terminal
      frame({ id: cid, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: cid, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: TEXT }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`refusal-stub-server mode=${mode} listening on http://127.0.0.1:${port}/v1`);
});
