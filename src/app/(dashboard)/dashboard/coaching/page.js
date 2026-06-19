"use client";

import { useEffect, useState } from "react";

export default function CoachingPage() {
  const [data, setData] = useState({ samples: [], pagination: { page: 1, totalPages: 1 } });
  const [model, setModel] = useState("");
  const [minScore, setMinScore] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [format, setFormat] = useState("sft");

  const load = async (page = 1) => {
    const qs = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (model) qs.set("model", model);
    if (minScore) qs.set("minScore", minScore);
    const res = await fetch(`/api/coaching/samples?${qs}`);
    setData(await res.json());
  };

  useEffect(() => { load(1); /* eslint-disable-next-line */ }, []);

  const exportUrl = () => {
    const qs = new URLSearchParams({ format });
    if (model) qs.set("model", model);
    if (minScore) qs.set("minScore", minScore);
    return `/api/coaching/export?${qs}`;
  };

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-lg font-semibold">Coaching Samples</h1>
      <div className="flex flex-wrap items-end gap-2">
        <input placeholder="student model" value={model} onChange={(e) => setModel(e.target.value)} className="rounded border border-border bg-transparent px-2 py-1 text-sm" />
        <input placeholder="min score" type="number" value={minScore} onChange={(e) => setMinScore(e.target.value)} className="w-24 rounded border border-border bg-transparent px-2 py-1 text-sm" />
        <button onClick={() => load(1)} className="rounded bg-primary px-3 py-1 text-sm text-white">Filter</button>
        <span className="ml-4 text-sm text-text-muted">Export</span>
        <select value={format} onChange={(e) => setFormat(e.target.value)} className="rounded border border-border bg-transparent px-2 py-1 text-sm">
          <option value="sft">SFT</option><option value="dpo">DPO</option><option value="raw">Raw</option>
        </select>
        <a href={exportUrl()} className="rounded border border-primary px-3 py-1 text-sm text-primary">Download JSONL</a>
      </div>

      <div className="space-y-2">
        {data.samples.length === 0 && <p className="text-sm text-text-muted">No samples yet.</p>}
        {data.samples.map((s) => (
          <div key={s.id} className="rounded border border-border p-3">
            <div className="flex cursor-pointer items-center justify-between" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
              <code className="text-xs">{s.studentModel} → {s.teacherModel || "—"}</code>
              <span className="text-xs text-text-muted">score: {s.overallScore ?? "—"} · {s.status} · {new Date(s.createdAt).toLocaleString()}</span>
            </div>
            {expanded === s.id && (
              <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                <div><div className="font-medium">Student</div><pre className="whitespace-pre-wrap">{s.studentAnswer}</pre></div>
                <div><div className="font-medium">Reference</div><pre className="whitespace-pre-wrap">{s.referenceAnswer}</pre></div>
                <div className="sm:col-span-2"><div className="font-medium">Critique</div><pre className="whitespace-pre-wrap">{JSON.stringify(s.critique, null, 2)}</pre></div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <button disabled={data.pagination.page <= 1} onClick={() => load(data.pagination.page - 1)} className="rounded border border-border px-2 py-1 disabled:opacity-40">Prev</button>
        <span>{data.pagination.page} / {data.pagination.totalPages || 1}</span>
        <button disabled={data.pagination.page >= (data.pagination.totalPages || 1)} onClick={() => load(data.pagination.page + 1)} className="rounded border border-border px-2 py-1 disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}
