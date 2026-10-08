import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// RED: these will fail until the files exist

describe("conversationFingerprint", () => {
  let conversationFingerprint;
  beforeEach(async () => {
    ({ conversationFingerprint } = await import("../../open-sse/services/refusalLog.js"));
  });

  it("fingerprint is stable across turns of one conversation", () => {
    const body1 = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
    };
    const body2 = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "Tell me more" },
      ],
    };
    const fp1 = conversationFingerprint(body1);
    const fp2 = conversationFingerprint(body2);
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(12);
    expect(fp1).toMatch(/^[0-9a-f]{12}$/);
  });

  it("fingerprint differs for different first user message", () => {
    const a = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "Hello" },
      ],
    };
    const b = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "World" },
      ],
    };
    expect(conversationFingerprint(a)).not.toBe(conversationFingerprint(b));
  });
});

describe("logRefusalCheck", () => {
  let logRefusalCheck;
  beforeEach(async () => {
    ({ logRefusalCheck } = await import("../../open-sse/services/refusalLog.js"));
  });

  it("appends one JSON line per call with ts", async () => {
    const tmp = path.join(os.tmpdir(), `refusal-log-test-${Date.now()}.jsonl`);
    logRefusalCheck({ decision: "pass", path: "jev:ok" }, { file: tmp });
    logRefusalCheck({ decision: "fallback", path: "jev:refusal" }, { file: tmp });
    const lines = fs.readFileSync(tmp, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const e0 = JSON.parse(lines[0]);
    const e1 = JSON.parse(lines[1]);
    expect(e0).toMatchObject({ decision: "pass", path: "jev:ok" });
    expect(e1).toMatchObject({ decision: "fallback", path: "jev:refusal" });
    expect(typeof e0.ts).toBe("string");
    expect(new Date(e0.ts).getFullYear()).toBeGreaterThan(2024);
    fs.unlinkSync(tmp);
  });

  it("never throws when the path is unwritable", () => {
    // Use a regular file as the "parent dir" so mkdirSync gets ENOTDIR instantly
    const tmpFile = path.join(os.tmpdir(), `refusal-not-a-dir-${Date.now()}`);
    fs.writeFileSync(tmpFile, "");
    const badPath = path.join(tmpFile, "sub", "x.jsonl");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => logRefusalCheck({ decision: "pass" }, { file: badPath })).not.toThrow();
      expect(() => logRefusalCheck({ decision: "pass" }, { file: badPath })).not.toThrow();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      fs.unlinkSync(tmpFile);
    }
  });

  it("resolves default path from DATA_DIR env", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refusal-datadir-"));
    const savedEnv = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
    try {
      // Re-import to pick up fresh module with new env (vitest caches modules;
      // logRefusalCheck resolves the path on each call so no re-import needed)
      const { logRefusalCheck: log } = await import("../../open-sse/services/refusalLog.js");
      log({ decision: "pass", path: "jev:ok" });
      const expected = path.join(tmpDir, "logs", "refusal-fallback.jsonl");
      const content = fs.readFileSync(expected, "utf8").trim();
      const entry = JSON.parse(content);
      expect(entry.decision).toBe("pass");
      expect(typeof entry.ts).toBe("string");
    } finally {
      process.env.DATA_DIR = savedEnv === undefined ? undefined : savedEnv;
      if (savedEnv === undefined) delete process.env.DATA_DIR;
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe("summarize", () => {
  let summarize;
  beforeEach(async () => {
    ({ summarize } = await import("../../scripts/refusal-thrash.mjs"));
  });

  it("counts paths, fallbacks, thrash, and percentiles", () => {
    // conv A: 3 entries (2 fallback) → thrash; conv B: 1 fallback; 1 skip:tool_calls
    const entries = [
      { conversation: "aaa", decision: "fallback", path: "jev:refusal", jevMs: 100 },
      { conversation: "aaa", decision: "fallback", path: "jev:refusal", jevMs: 200 },
      { conversation: "aaa", decision: "pass",     path: "jev:ok",      jevMs: 300 },
      { conversation: "bbb", decision: "fallback", path: "jev:refusal", jevMs: null },
      { conversation: "ccc", decision: "skip",     path: "skip:tool_calls", jevMs: null },
    ];
    const r = summarize(entries);
    expect(r.checks).toBe(5);
    expect(r.fallbacks).toBe(3);
    expect(r.conversationsWithFallback).toBe(2);
    expect(r.thrashConversations).toBe(1);
    expect(r.byPath["skip:tool_calls"]).toBe(1);
    expect(r.jevMsP50).toBe(200);
    expect(r.jevMsP95).toBe(300);
  });
});
