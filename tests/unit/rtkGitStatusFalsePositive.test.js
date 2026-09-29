import { describe, it, expect } from "vitest";
import { autoDetectFilter } from "../../open-sse/rtk/autodetect.js";
import { gitStatus } from "../../open-sse/rtk/filters/gitStatus.js";
import { compressMessages } from "../../open-sse/rtk/index.js";

// Regression: indented, aligned "score table" output (e.g. a skill-picker's
//   "   0.520  digin" rows) was being misdetected as `git status` porcelain and
// collapsed to "clean — nothing to commit", destroying the real tool output.
//
// Root cause: RE_PORCELAIN (/^[ MADRCU?!][ MADRCU?!] \S/) accepts a leading
// SPACE as a valid porcelain status column, so any block where >=60% of lines
// start with two spaces + non-space matched isMostlyPorcelain() and routed to
// the gitStatus filter, whose all-zero-counts branch emits "clean — nothing to
// commit".

const scoreTable = Array.from({ length: 29 }, (_, i) =>
  `   0.${String(i).padStart(3, "0")}  token${i}`
).join("\n");

describe("RTK git-status porcelain false-positive", () => {
  it("does NOT detect an aligned score table as git-status", () => {
    const fn = autoDetectFilter(scoreTable);
    const name = fn ? fn.filterName || fn.name : null;
    expect(name).not.toBe("git-status");
  });

  it("gitStatus() never invents 'clean — nothing to commit' from all-blank status codes", () => {
    // Even if forced through the filter, blank X/Y codes are not a clean repo.
    const out = gitStatus(scoreTable);
    expect(out).not.toBe("clean — nothing to commit");
  });

  it("real git status --porcelain output is still detected and summarized", () => {
    const porcelain = [
      "## main...origin/main",
      " M src/a.js",
      "A  src/b.js",
      "?? notes.txt",
    ].join("\n");
    const fn = autoDetectFilter(porcelain);
    expect(fn && (fn.filterName || fn.name)).toBe("git-status");
    const out = gitStatus(porcelain);
    expect(out).toContain("main");
    expect(out).not.toBe("clean — nothing to commit");
  });

  it("real long-form `git status` (clean tree) still summarizes to clean", () => {
    const clean = [
      "On branch main",
      "Your branch is up to date with 'origin/main'.",
      "",
      "nothing to commit, working tree clean",
    ].join("\n");
    const fn = autoDetectFilter(clean);
    expect(fn && (fn.filterName || fn.name)).toBe("git-status");
    expect(gitStatus(clean)).toContain("clean — nothing to commit");
  });

  it("end-to-end: compressMessages leaves a >=500-byte score table intact", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: scoreTable }] },
      ],
    };
    // bytes must exceed MIN_COMPRESS_SIZE so the compressor actually runs.
    expect(Buffer.byteLength(scoreTable)).toBeGreaterThanOrEqual(500);
    compressMessages(body, true);
    const text = body.messages[0].content[0].content;
    expect(text).toContain("0.000  token0");
    expect(text).not.toBe("clean — nothing to commit");
  });
});
