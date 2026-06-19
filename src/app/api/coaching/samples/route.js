import { NextResponse } from "next/server";
import { listCoachingSamples } from "@/lib/db/repos/coachingSamplesRepo.js";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const filter = {
    page: parseInt(searchParams.get("page"), 10) || 1,
    pageSize: Math.min(100, parseInt(searchParams.get("pageSize"), 10) || 25),
  };
  if (searchParams.get("model")) filter.studentModel = searchParams.get("model");
  const minScoreRaw = searchParams.get("minScore");
  if (minScoreRaw !== null && minScoreRaw !== "") {
    const parsed = parseInt(minScoreRaw, 10);
    if (!Number.isNaN(parsed)) filter.minScore = parsed;
  }
  const result = await listCoachingSamples(filter);
  return NextResponse.json(result);
}
