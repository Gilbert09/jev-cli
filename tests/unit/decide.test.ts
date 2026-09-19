import { describe, expect, it } from "vitest";
import {
  confident,
  explain,
  likely,
  massAtOrAbove,
  noulConfidence,
  noulFinding,
  pct,
  scoreAtLeast,
  scoreFinding,
  validateScore,
} from "../../src/core/decide.js";
import type { NoulAnswer, ScoreAnswer } from "../../src/core/types.js";

const noulOf = (p: number): NoulAnswer => ({
  type: "noul",
  noul: p,
  confidence: noulConfidence(p),
});

const scoreOf = (score: number, levels: number, probabilities?: Record<string, number>): ScoreAnswer => ({
  type: "score",
  score,
  nearest: Math.round(score),
  levels,
  probabilities:
    probabilities ??
    Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), 1 / levels])),
  legend: {},
  confidence: 0.9,
});

describe("noulConfidence", () => {
  it.each([
    [0.5, 0],
    [1, 1],
    [0, 1],
    [0.75, 0.5],
    [0.25, 0.5],
  ])("maps p=%s to confidence %s", (p, expected) => {
    expect(noulConfidence(p)).toBeCloseTo(expected, 6);
  });

  it("treats a non-finite probability as no confidence at all", () => {
    expect(noulConfidence(Number.NaN)).toBe(0);
  });

  it("clamps out-of-range probabilities rather than exceeding 1", () => {
    expect(noulConfidence(1.4)).toBe(1);
    expect(noulConfidence(-0.4)).toBe(1);
  });
});

describe("validateScore", () => {
  // Rubrics are 0-based: a 4-level rubric spans [0, 3].
  it.each([
    [0, 4],
    [3, 4],
    [2.4, 4],
    [1.999, 4],
  ])("accepts %s on a %s-level rubric", (raw, levels) => {
    expect(validateScore(raw, levels)).toBeCloseTo(raw, 6);
  });

  it("rejects a value above the rubric, rather than clamping it", () => {
    // A 1-based assumption would land here. Silently clamping would mis-gate a
    // destructive command, so this must throw.
    expect(() => validateScore(4, 4)).toThrow(/outside \[0, 3\]/);
  });

  it("rejects negatives and non-finite values", () => {
    expect(() => validateScore(-1, 4)).toThrow(RangeError);
    expect(() => validateScore(Number.NaN, 4)).toThrow(/not a finite number/);
  });

  it("rejects impossible rubric sizes", () => {
    expect(() => validateScore(0, 1)).toThrow(/2\.\.10 levels/);
    expect(() => validateScore(0, 11)).toThrow(/2\.\.10 levels/);
  });

  it("tolerates floating point landing a hair outside the range", () => {
    expect(validateScore(3.0000000001, 4)).toBeCloseTo(3, 6);
  });
});

describe("confidence gating", () => {
  it("requires both probability and confidence for `likely`", () => {
    expect(likely(noulOf(0.95), 0.7, 0.5)).toBe(true);
    // p clears the bar but 0.6 is a weak signal: confidence is only 0.2.
    expect(likely(noulOf(0.6), 0.55, 0.5)).toBe(false);
    expect(likely(noulOf(0.4), 0.7, 0.1)).toBe(false);
  });

  it("gates scores on confidence too", () => {
    const low = { ...scoreOf(3, 4), confidence: 0.2 };
    expect(scoreAtLeast(scoreOf(3, 4), 2.5, 0.8)).toBe(true);
    expect(scoreAtLeast(low, 2.5, 0.8)).toBe(false);
  });

  it("exposes a uniform confidence check across answer types", () => {
    expect(confident(noulOf(0.99), 0.9)).toBe(true);
    expect(confident(noulOf(0.55), 0.9)).toBe(false);
  });
});

describe("massAtOrAbove", () => {
  it("sums the dangerous tail, catching bimodal answers a mean would hide", () => {
    // Expected score is a mild 1.5, but a third of the mass sits on level 3.
    const bimodal = scoreOf(1.5, 4, { "0": 0.34, "1": 0.0, "2": 0.33, "3": 0.33 });
    expect(bimodal.score).toBeLessThan(2);
    expect(massAtOrAbove(bimodal, 3)).toBeCloseTo(0.33, 6);
    expect(massAtOrAbove(bimodal, 2)).toBeCloseTo(0.66, 6);
  });

  it("ignores keys that are not level indices", () => {
    const a = scoreOf(1, 2, { "0": 0.5, "1": 0.5, junk: 99 } as Record<string, number>);
    expect(massAtOrAbove(a, 0)).toBeCloseTo(1, 6);
  });
});

describe("explain", () => {
  it("says so plainly when nothing fired", () => {
    expect(explain([])).toBe("no risk signals above threshold");
  });

  it("renders probabilities and scores in their own units", () => {
    const text = explain([
      scoreFinding("danger", "deletes project files", scoreOf(2.4, 4)),
      noulFinding("escapes", "affects files outside the project", noulOf(0.91)),
    ]);
    expect(text).toContain("deletes project files (2.4 of 0-3");
    expect(text).toContain("affects files outside the project (91%)");
  });

  it("formats percentages without decimal noise", () => {
    expect(pct(0.9149)).toBe("91%");
  });
});
