import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// aggregateWeaknesses scans up to this many recent samples in-memory; older
// samples beyond this cap are not counted. Raise if datasets grow large.
const AGGREGATE_SCAN_CAP = 10000;

function genId(model) {
  const ts = new Date().toISOString();
  const rand = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? String(model).replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${ts}-${rand}-${modelPart}`;
}

// Re-hydrate a DB row into the full record (data column holds the JSON payload).
function rowToRecord(row) {
  if (!row) return null;
  const data = parseJson(row.data, {});
  return {
    id: row.id,
    comboName: row.comboName,
    studentModel: row.studentModel,
    teacherModel: row.teacherModel,
    createdAt: row.createdAt,
    servedBy: row.servedBy,
    overallScore: row.overallScore == null ? null : Number(row.overallScore),
    status: row.status,
    prompt: data.prompt ?? {},
    studentAnswer: data.studentAnswer ?? "",
    referenceAnswer: data.referenceAnswer ?? "",
    critique: data.critique ?? null,
    tokens: data.tokens ?? null,
  };
}

export async function saveCoachingSample(record) {
  const db = await getAdapter();
  const id = record.id || genId(record.studentModel);
  const createdAt = record.createdAt || new Date().toISOString();
  const score = (typeof record.overallScore === "number" && Number.isFinite(record.overallScore))
    ? Math.round(record.overallScore) : null;
  const data = stringifyJson({
    prompt: record.prompt ?? {},
    studentAnswer: record.studentAnswer ?? "",
    referenceAnswer: record.referenceAnswer ?? "",
    critique: record.critique ?? null,
    tokens: record.tokens ?? null,
  });
  db.run(
    `INSERT INTO coachingSamples(id, comboName, studentModel, teacherModel, createdAt, servedBy, overallScore, status, data)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, overallScore = excluded.overallScore, status = excluded.status`,
    [id, record.comboName || null, record.studentModel || "unknown", record.teacherModel || null,
     createdAt, record.servedBy || null, score, record.status || "ok", data]
  );
  return id;
}

export async function getCoachingSample(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM coachingSamples WHERE id = ?`, [id]);
  return rowToRecord(row);
}

function buildWhere(filter = {}) {
  const conds = [];
  const params = [];
  if (filter.comboName) { conds.push("comboName = ?"); params.push(filter.comboName); }
  if (filter.studentModel) { conds.push("studentModel = ?"); params.push(filter.studentModel); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (typeof filter.minScore === "number") { conds.push("overallScore >= ?"); params.push(filter.minScore); }
  if (filter.since) { conds.push("createdAt >= ?"); params.push(new Date(filter.since).toISOString()); }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

export async function listCoachingSamples(filter = {}) {
  const db = await getAdapter();
  const { where, params } = buildWhere(filter);
  const cnt = db.get(`SELECT COUNT(*) as c FROM coachingSamples ${where}`, params);
  const totalItems = cnt ? cnt.c : 0;
  const page = filter.page || 1;
  const pageSize = filter.pageSize || 25;
  const offset = (page - 1) * pageSize;
  const rows = db.all(
    `SELECT * FROM coachingSamples ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return {
    samples: rows.map(rowToRecord),
    pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
  };
}

export async function exportSamples(filter = {}) {
  const db = await getAdapter();
  const f = { ...filter };
  if (!f.includeAll && !f.status) f.status = "ok";
  const { where, params } = buildWhere(f);
  const rows = db.all(`SELECT * FROM coachingSamples ${where} ORDER BY createdAt ASC`, params);
  return rows.map(rowToRecord);
}

export async function aggregateWeaknesses({ studentModel, since } = {}) {
  const { samples } = await listCoachingSamples({ studentModel, since, pageSize: AGGREGATE_SCAN_CAP });
  const tally = new Map();
  for (const s of samples) {
    const ws = [...(s.critique?.weaknesses || []), ...(s.critique?.failure_modes || [])];
    for (const w of ws) {
      const key = String(w).trim().toLowerCase();
      if (!key) continue;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
  }
  return [...tally.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count);
}
