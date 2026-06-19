import { exportSamples } from "@/lib/db/repos/coachingSamplesRepo.js";

// Pure transform: a stored record → one export object for the requested format.
export function formatSample(record, format) {
  const messages = record.prompt?.messages || record.prompt?.input || [];
  if (format === "dpo") {
    return { prompt: messages, chosen: record.referenceAnswer || "", rejected: record.studentAnswer || "" };
  }
  if (format === "raw") {
    return record;
  }
  // default: sft
  return { messages, completion: record.referenceAnswer || "" };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const format = (searchParams.get("format") || "sft").toLowerCase();
  if (!["sft", "dpo", "raw"].includes(format)) {
    return new Response(JSON.stringify({ error: "format must be sft|dpo|raw" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const filter = {};
  if (searchParams.get("model")) filter.studentModel = searchParams.get("model");
  if (searchParams.get("since")) filter.since = searchParams.get("since");
  if (searchParams.get("minScore")) filter.minScore = parseInt(searchParams.get("minScore"), 10);
  if (format === "raw") filter.includeAll = true;

  const records = await exportSamples(filter);
  const body = records.map((r) => JSON.stringify(formatSample(r, format))).join("\n") + (records.length ? "\n" : "");
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="coaching-${format}-${new Date().toISOString().slice(0, 10)}.jsonl"`,
    },
  });
}
