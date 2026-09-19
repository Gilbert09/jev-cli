import type { Answer, NoulAnswer, ScoreAnswer } from "./types.js";

/**
 * Pure decision helpers. No I/O, no network, no config — everything here is a
 * total function over answers and thresholds, so it can be exhaustively
 * unit-tested including every failure branch.
 */

/**
 * Derive a confidence for a noul answer.
 *
 * The API does not report one (unlike `choice` and `score`), but a probability
 * is itself an uncertainty statement: 0.97 and 0.03 are both confident, 0.5 is
 * maximal doubt. Rescaling |p - 0.5| to 0..1 gives every capability a single
 * uniform confidence gate across all three primitive types.
 */
export function noulConfidence(probability: number): number {
  if (!Number.isFinite(probability)) return 0;
  const clamped = Math.min(1, Math.max(0, probability));
  return Math.abs(clamped - 0.5) * 2;
}

/**
 * Validate a raw expected score against its rubric.
 *
 * Rubrics are indexed FROM ZERO, so a 4-level rubric yields scores in [0, 3],
 * and the value may be fractional because it is an expectation over the level
 * distribution. A value outside that range means our understanding of the API
 * is wrong; for a capability that gates destructive commands, that has to be a
 * loud failure rather than a silent clamp.
 */
export function validateScore(raw: number, levels: number): number {
  if (!Number.isFinite(raw)) {
    throw new RangeError(`score is not a finite number: ${raw}`);
  }
  if (levels < 2 || levels > 10) {
    throw new RangeError(`rubric must have 2..10 levels, got ${levels}`);
  }
  // Small epsilon: floating point expectations can land a hair outside.
  if (raw < -1e-6 || raw > levels - 1 + 1e-6) {
    throw new RangeError(
      `score ${raw} outside [0, ${levels - 1}] for a ${levels}-level rubric; ` +
        "the Jev score encoding differs from what jev-cli assumes",
    );
  }
  return Math.min(levels - 1, Math.max(0, raw));
}

/** True when the model is confident enough for the stakes involved. */
export function confident(answer: Answer, min: number): boolean {
  return answer.confidence >= min;
}

/** A noul counts as "likely true" only if it clears BOTH bars. */
export function likely(answer: NoulAnswer, probability: number, minConfidence: number): boolean {
  return answer.noul >= probability && answer.confidence >= minConfidence;
}

/** True when the expected score reaches `threshold` with sufficient confidence. */
export function scoreAtLeast(
  answer: ScoreAnswer,
  threshold: number,
  minConfidence: number,
): boolean {
  return answer.score >= threshold && answer.confidence >= minConfidence;
}

/**
 * Total probability mass at or above a level. Useful when the tail matters more
 * than the mean: a bimodal "either harmless or catastrophic" answer has a
 * middling expected score but real mass on the dangerous end.
 */
export function massAtOrAbove(answer: ScoreAnswer, level: number): number {
  let total = 0;
  for (const [key, p] of Object.entries(answer.probabilities)) {
    const idx = Number(key);
    if (Number.isFinite(idx) && idx >= level) total += p;
  }
  return total;
}

/**
 * One contributing signal in a decision, kept so the reason string cites
 * concrete numbers instead of an opaque verdict.
 */
export interface Finding {
  /** Short stable identifier, e.g. "danger" or "escapesProject". */
  key: string;
  /** Human-readable phrase, e.g. "deletes data outside the project". */
  detail: string;
  value: number;
  confidence: number;
  as: "probability" | "score";
  /** For scores: the rubric size, so the reason can render "2.4 of 0-3". */
  levels?: number;
}

export function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** Render findings into the single reason line a user actually reads. */
export function explain(findings: readonly Finding[]): string {
  if (findings.length === 0) return "no risk signals above threshold";
  return findings
    .map((f) =>
      f.as === "probability"
        ? `${f.detail} (${pct(f.value)})`
        : `${f.detail} (${f.value.toFixed(1)} of 0-${(f.levels ?? 1) - 1}, confidence ${pct(f.confidence)})`,
    )
    .join("; ");
}

export function noulFinding(key: string, detail: string, answer: NoulAnswer): Finding {
  return {
    key,
    detail,
    value: answer.noul,
    confidence: answer.confidence,
    as: "probability",
  };
}

export function scoreFinding(key: string, detail: string, answer: ScoreAnswer): Finding {
  return {
    key,
    detail,
    value: answer.score,
    confidence: answer.confidence,
    as: "score",
    levels: answer.levels,
  };
}
