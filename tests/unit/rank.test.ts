import { describe, expect, it } from "vitest";
import {
  assignIds,
  batchCandidates,
  mergeRounds,
  rankCandidates,
  type RankCandidate,
} from "../../src/capabilities/rank/rank.js";
import { TUNING, buildQuestions } from "../../src/capabilities/rank/questions.js";
import type { AskOptions } from "../../src/core/jev.js";
import type { Answer, JevFailure } from "../../src/core/types.js";
import { noulConfidence } from "../../src/core/decide.js";

/**
 * Everything here runs offline. `ask` is injected, so these tests cover the
 * parts that must be right regardless of what the model says: which candidates
 * get sent, under which ids, in which batches, and what comes back out when a
 * call fails.
 */

interface SeenCall {
  ids: string[];
  paths: string[];
  excerpts: string[];
}

interface FakeAskOptions {
  /** Probabilities per id for a batch. Defaults to a descending ramp. */
  scores?: (ids: string[]) => Record<string, number>;
  /** Presence probability for a batch. */
  present?: (ids: string[]) => number;
  /** Return a failure instead of an answer for the nth call (0-based). */
  failOn?: number;
  failure?: JevFailure;
}

function fakeAsk(options: FakeAskOptions = {}): {
  ask: never;
  calls: SeenCall[];
} {
  const calls: SeenCall[] = [];

  const impl = async (opts: AskOptions) => {
    const state = opts.state as { files: Array<{ id: string; path: string; excerpt: string }> };
    const ids = state.files.map((f) => f.id);
    const index = calls.length;
    calls.push({
      ids,
      paths: state.files.map((f) => f.path),
      excerpts: state.files.map((f) => f.excerpt),
    });

    if (options.failOn === index) {
      return { ok: false as const, error: options.failure ?? { type: "timeout" as const, ms: 4000 }, ms: 1 };
    }

    const raw =
      options.scores?.(ids) ??
      Object.fromEntries(ids.map((id, i) => [id, (ids.length - i) / ids.length]));
    const total = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
    const probabilities = Object.fromEntries(
      Object.entries(raw).map(([id, value]) => [id, value / total]),
    );
    const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ids[0] ?? "";
    const p = options.present?.(ids) ?? 0.9;

    const answers: Record<string, Answer> = {
      present: { type: "noul", noul: p, confidence: noulConfidence(p) },
    };
    if ("best" in opts.questions) {
      answers.best = { type: "choice", choice: top, probabilities, confidence: 0.8 };
    }
    return { ok: true as const, answers, cached: false, ms: 1 };
  };

  return { ask: impl as never, calls };
}

const candidatesOf = (n: number, snippet = "export const x = 1;\n"): RankCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ path: `src/m${i}.ts`, snippet }));

describe("assignIds", () => {
  it("gives every candidate an id, with no duplicates", () => {
    const ids = assignIds(candidatesOf(50));
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
  });

  it("keeps a caller id that is short and option-safe", () => {
    const ids = assignIds([
      { id: "alpha", path: "a.ts" },
      { id: "beta-2", path: "b.ts" },
    ]);
    expect(ids).toEqual(["alpha", "beta-2"]);
  });

  it.each([
    ["", "empty"],
    ["has space", "whitespace"],
    ["way-too-long-an-identifier", "over 16 characters"],
    ["quote\"d", "quote"],
  ])("falls back to a positional id for %s (%s)", (bad) => {
    const ids = assignIds([{ id: bad, path: "a.ts" }]);
    expect(ids).toEqual(["f0"]);
  });

  it("never lets a caller id collide with a generated one", () => {
    // "f1" is exactly what index 1 would generate.
    const ids = assignIds([{ id: "f1", path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }]);
    expect(ids).toEqual(["f1", "f1_1", "f2"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("de-duplicates repeated caller ids", () => {
    const ids = assignIds([
      { id: "same", path: "a.ts" },
      { id: "same", path: "b.ts" },
    ]);
    expect(ids).toEqual(["same", "f1"]);
  });

  it("maps positionally, so an id always points at its own candidate", async () => {
    const candidates: RankCandidate[] = [
      { path: "src/alpha.ts", snippet: "alpha" },
      { id: "keep", path: "src/beta.ts", snippet: "beta" },
      { path: "src/gamma.ts", snippet: "gamma" },
    ];
    const ids = assignIds(candidates);
    const { ask, calls } = fakeAsk();
    await rankCandidates({ query: "q", candidates }, { ask });

    const seen = calls[0];
    expect(seen).toBeDefined();
    expect(seen?.ids).toEqual(ids);
    // The id at position i must be sent alongside the path at position i.
    seen?.ids.forEach((id, i) => {
      expect(id).toBe(ids[i]);
      expect(seen.paths[i]).toBe(candidates[i]?.path);
    });
  });
});

describe("batchCandidates", () => {
  const entries = (n: number, snippet = "x") =>
    Array.from({ length: n }, (_, i) => ({ path: `p${i}`, snippet }));
  const limits = { maxPerBatch: 10, maxBytesPerBatch: 1_000_000 };

  it.each([
    [1, [1]],
    [9, [9]],
    [10, [10]],
    [11, [10, 1]],
    [20, [10, 10]],
    [21, [10, 10, 1]],
  ])("splits %i candidates into %j", (n, sizes) => {
    expect(batchCandidates(entries(n), limits).map((b) => b.length)).toEqual(sizes);
  });

  it("returns nothing for an empty list", () => {
    expect(batchCandidates([], limits)).toEqual([]);
  });

  it("loses no candidate and keeps the original order", () => {
    const input = entries(37);
    const flat = batchCandidates(input, limits).flat();
    expect(flat).toHaveLength(37);
    expect(flat.map((e) => e.path)).toEqual(input.map((e) => e.path));
  });

  it("splits on the byte budget before the count cap is reached", () => {
    // Each entry is 100 bytes of snippet plus a 2-byte path.
    const big = entries(10, "y".repeat(100));
    const batches = batchCandidates(big, { maxPerBatch: 10, maxBytesPerBatch: 300 });
    expect(batches.map((b) => b.length)).toEqual([2, 2, 2, 2, 2]);
    expect(batches.flat()).toHaveLength(10);
  });

  it("gives an entry larger than the whole budget its own batch rather than dropping it", () => {
    const mixed = [
      { path: "small", snippet: "a" },
      { path: "huge", snippet: "z".repeat(5000) },
      { path: "small2", snippet: "b" },
    ];
    const batches = batchCandidates(mixed, { maxPerBatch: 10, maxBytesPerBatch: 100 });
    expect(batches.flat().map((e) => e.path)).toEqual(["small", "huge", "small2"]);
    expect(batches.some((b) => b.length === 1 && b[0]?.path === "huge")).toBe(true);
  });

  it("treats a nonsensical batch size as one per batch rather than looping forever", () => {
    expect(batchCandidates(entries(3), { maxPerBatch: 0, maxBytesPerBatch: 10 })).toHaveLength(3);
  });
});

describe("mergeRounds", () => {
  it("returns nothing for no rounds", () => {
    expect(mergeRounds([])).toEqual([]);
  });

  it("orders a single round by probability", () => {
    expect(mergeRounds([{ a: 0.1, b: 0.7, c: 0.2 }]).map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  it("ranks a later-round survivor above a higher score from an earlier round", () => {
    // `a` won a weak batch with 0.95; `b` and `c` went on to be compared against
    // the rest of the field. Surviving the runoff is the stronger evidence.
    const merged = mergeRounds([
      { a: 0.95, b: 0.4, c: 0.3, d: 0.05 },
      { b: 0.6, c: 0.4 },
    ]);
    expect(merged.map((e) => e.id)).toEqual(["b", "c", "a", "d"]);
    expect(merged[0]).toMatchObject({ id: "b", rounds: 2, score: 0.6 });
    expect(merged[2]).toMatchObject({ id: "a", rounds: 1, score: 0.95 });
  });

  it("uses the latest round's score for a survivor, not its best ever score", () => {
    const merged = mergeRounds([{ a: 0.9 }, { a: 0.2 }]);
    expect(merged[0]).toMatchObject({ id: "a", score: 0.2, rounds: 2 });
  });

  it("breaks ties deterministically on id", () => {
    expect(mergeRounds([{ z: 0.5, a: 0.5, m: 0.5 }]).map((e) => e.id)).toEqual(["a", "m", "z"]);
  });

  it("treats a non-finite probability as zero", () => {
    const merged = mergeRounds([{ a: Number.NaN, b: 0.1 }]);
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
    expect(merged[1]?.score).toBe(0);
  });
});

describe("buildQuestions", () => {
  it("asks both questions when there is a real choice to make", () => {
    const q = buildQuestions([
      { id: "a", path: "a.ts", snippet: "" },
      { id: "b", path: "b.ts", snippet: "" },
    ]);
    expect(Object.keys(q).sort()).toEqual(["best", "present"]);
    expect((q.best as { criteria: Record<string, string> }).criteria).toEqual({
      a: "a.ts",
      b: "b.ts",
    });
  });

  it("drops the choice when a batch holds one candidate, since a choice of one is meaningless", () => {
    const q = buildQuestions([{ id: "a", path: "a.ts", snippet: "" }]);
    expect(Object.keys(q)).toEqual(["present"]);
  });
});

describe("rankCandidates", () => {
  it("returns a ranking and the presence probability for one batch", async () => {
    const { ask, calls } = fakeAsk({ present: () => 0.88 });
    const result = await rankCandidates(
      { query: "where is the pool configured?", candidates: candidatesOf(5) },
      { ask },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(1);
    expect(result.calls).toBe(1);
    expect(result.rounds).toBe(1);
    expect(result.considered).toBe(5);
    expect(result.present).toBeCloseTo(0.88, 6);
    expect(result.presentConfidence).toBeCloseTo(noulConfidence(0.88), 6);
    expect(result.ranked.map((r) => r.path)).toEqual([
      "src/m0.ts",
      "src/m1.ts",
      "src/m2.ts",
      "src/m3.ts",
      "src/m4.ts",
    ]);
  });

  it("defaults topK and clamps the caller's request in both directions", async () => {
    const run = async (topK?: number) => {
      const { ask } = fakeAsk();
      const result = await rankCandidates(
        { query: "q", candidates: candidatesOf(40), topK },
        { ask },
      );
      return result.ok ? result.ranked.length : -1;
    };

    expect(await run(undefined)).toBe(TUNING.defaultTopK);
    expect(await run(2)).toBe(2);
    expect(await run(1000)).toBe(TUNING.maxTopK);
    expect(await run(0)).toBe(1);
    expect(await run(-5)).toBe(1);
  });

  it("asks nothing and ranks nothing when there are no candidates", async () => {
    const { ask, calls } = fakeAsk();
    const result = await rankCandidates({ query: "q", candidates: [] }, { ask });

    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ranked).toEqual([]);
    expect(result.considered).toBe(0);
    expect(result.calls).toBe(0);
    // An empty set provably does not contain the answer.
    expect(result.present).toBe(0);
    expect(result.presentConfidence).toBe(1);
  });

  it("batches a large candidate set and runs a runoff over the batch winners", async () => {
    const { ask, calls } = fakeAsk();
    const result = await rankCandidates({ query: "q", candidates: candidatesOf(50) }, { ask });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 50 candidates at 24 per batch: three batches, then one runoff batch.
    const roundOne = calls.slice(0, 3).map((c) => c.ids.length);
    expect(roundOne).toEqual([24, 24, 2]);
    expect(calls).toHaveLength(4);
    expect(result.rounds).toBe(2);
    // The runoff holds finalistsPerBatch from each full batch, plus the short one.
    expect(calls[3]?.ids).toHaveLength(TUNING.finalistsPerBatch * 2 + 2);
    // No candidate is lost by batching.
    expect(new Set(calls.slice(0, 3).flatMap((c) => c.ids)).size).toBe(50);
  });

  it("lets the runoff overturn a round-one winner from a weak batch", async () => {
    // f0 dominates its own batch; f24 only just wins batch two. In the runoff
    // (the one call that sees both) f24 wins, and that must be the final order.
    const scores = (ids: string[]) => {
      const runoff = ids.includes("f0") && ids.includes("f24");
      const out: Record<string, number> = {};
      for (const id of ids) out[id] = 0.01;
      if (runoff) {
        out.f24 = 0.9;
        out.f0 = 0.05;
      } else {
        if (ids.includes("f0")) out.f0 = 0.95;
        if (ids.includes("f24")) out.f24 = 0.3;
      }
      return out;
    };

    const { ask } = fakeAsk({ scores });
    const result = await rankCandidates(
      { query: "q", candidates: candidatesOf(50), topK: 3 },
      { ask },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ranked[0]?.path).toBe("src/m24.ts");
    expect(result.ranked[0]?.rounds).toBe(2);
    expect(result.ranked.map((r) => r.path)).toContain("src/m0.ts");
  });

  it("reports presence from the final round, not the loudest batch of round one", async () => {
    // Round one has three batches; one of them is sure the answer is there.
    // The runoff, which sees the best of every batch, says no. Reporting the
    // round-one maximum would turn every large search into a false positive.
    const present = (ids: string[]) => {
      if (ids.includes("f0") && ids.includes("f24")) return 0.04;
      return ids.includes("f24") ? 0.97 : 0.3;
    };

    const { ask } = fakeAsk({ present });
    const result = await rankCandidates({ query: "q", candidates: candidatesOf(50) }, { ask });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.present).toBeCloseTo(0.04, 6);
    expect(result.present).toBeLessThan(TUNING.presentThreshold);
  });

  it.each([
    [{ type: "timeout" as const, ms: 4000 }],
    [{ type: "no_api_key" as const }],
    [{ type: "api_error" as const, status: 503, message: "upstream" }],
    [{ type: "malformed" as const, message: "no answers field" }],
  ])("propagates %j instead of inventing a ranking", async (failure) => {
    const { ask } = fakeAsk({ failOn: 0, failure });
    const result = await rankCandidates({ query: "q", candidates: candidatesOf(5) }, { ask });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(failure);
    expect(result).not.toHaveProperty("ranked");
  });

  it("fails the whole call when a later batch fails, rather than ranking the batches that worked", async () => {
    const { ask } = fakeAsk({ failOn: 2 });
    const result = await rankCandidates({ query: "q", candidates: candidatesOf(50) }, { ask });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ type: "timeout", ms: 4000 });
  });

  it("fails when the runoff round fails, even though round one succeeded", async () => {
    const { ask } = fakeAsk({ failOn: 3 });
    const result = await rankCandidates({ query: "q", candidates: candidatesOf(50) }, { ask });
    expect(result.ok).toBe(false);
  });

  it("cuts an oversized candidate list to the configured ceiling and says so", async () => {
    const { ask, calls } = fakeAsk();
    const result = await rankCandidates({ query: "q", candidates: candidatesOf(420) }, { ask });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.considered).toBe(400);
    const firstRound = calls.slice(0, Math.ceil(400 / TUNING.maxCandidatesPerBatch));
    expect(firstRound.flatMap((c) => c.ids)).toHaveLength(400);
  });

  it("does not flag truncation when the list fits", async () => {
    const { ask } = fakeAsk();
    const result = await rankCandidates({ query: "q", candidates: candidatesOf(3) }, { ask });
    expect(result.ok && result.truncated).toBe(false);
  });

  it("reads a bounded head of the file when no snippet is supplied", async () => {
    const seen: Array<[string, number]> = [];
    const { ask, calls } = fakeAsk();
    await rankCandidates(
      { query: "q", candidates: [{ path: "src/big.ts" }] },
      {
        ask,
        readHead: (path, maxBytes) => {
          seen.push([path, maxBytes]);
          return "file head";
        },
      },
    );

    expect(seen).toEqual([["src/big.ts", TUNING.maxSnippetBytes * 2]]);
    expect(calls[0]?.excerpts).toEqual(["file head"]);
  });

  it("redacts and bounds content before it leaves the machine", async () => {
    const { ask, calls } = fakeAsk();
    await rankCandidates(
      {
        query: "q",
        candidates: [
          { path: "a.ts", snippet: "const key = 'sk-ant-abcdefghijklmnop';" },
          { path: "b.ts", snippet: "z".repeat(TUNING.maxSnippetBytes * 4) },
        ],
      },
      { ask },
    );

    const excerpts = calls[0]?.excerpts ?? [];
    expect(excerpts[0]).toContain("[redacted-api-key]");
    expect(excerpts[0]).not.toContain("sk-ant-abcdefghijklmnop");
    expect(Buffer.byteLength(excerpts[1] ?? "", "utf8")).toBe(TUNING.maxSnippetBytes);
  });

  it("scores a lone candidate from the presence answer, since a choice of one says nothing", async () => {
    const { ask, calls } = fakeAsk({ present: () => 0.72 });
    const result = await rankCandidates(
      { query: "q", candidates: [{ path: "only.ts", snippet: "x" }] },
      { ask },
    );

    expect(calls[0]?.ids).toHaveLength(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ranked).toEqual([
      { id: "f0", path: "only.ts", score: 0.72, rounds: 1 },
    ]);
  });
});
