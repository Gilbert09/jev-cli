import { closeSync, openSync, readSync } from "node:fs";
import { ask as realAsk } from "../../core/jev.js";
import { loadConfig } from "../../core/config.js";
import { prepare } from "../../core/redact.js";
import type { Answer, ChoiceAnswer, JevFailure, JevResult, NoulAnswer } from "../../core/types.js";
import { TUNING, buildQuestions, buildState, type BatchEntry } from "./questions.js";

/**
 * Ranking logic for the `rank` MCP tool.
 *
 * Shape of the problem: a `choice` question accepts at most 255 options and a
 * request accepts at most 64k tokens, but Claude may hand us hundreds of
 * candidates with their content. So the work is a tournament:
 *
 *   round 1  split the candidates into batches, rank each batch independently
 *   round N  promote the top few from every batch and rank those against each
 *            other, repeating until a single batch remains
 *
 * The runoff exists because per-batch probabilities are NOT comparable across
 * batches: each batch's probabilities are normalised within that batch, so the
 * winner of a batch full of irrelevant files scores as highly as the winner of
 * the batch that holds the real answer. Comparing raw numbers across batches
 * would systematically favour candidates that happened to land among weak
 * company. Putting the finalists in one context fixes that.
 *
 * The tradeoff: the runoff costs one extra round trip per round (3 rounds
 * covers the 400-candidate ceiling), and candidates eliminated in round 1 are
 * only ordered against their own batch. That is deliberate — the tool's job is
 * a correct TOP of the list, and positions 20-400 are never read by anyone.
 */

export interface RankCandidate {
  id?: string;
  path: string;
  snippet?: string;
}

export interface RankRequest {
  query: string;
  candidates: readonly RankCandidate[];
  topK?: number;
}

export interface RankedCandidate {
  id: string;
  path: string;
  /** Probability from the last round this candidate survived, 0..1. */
  score: number;
  /** How many rounds it survived. Higher beats a higher `score` from round 1. */
  rounds: number;
}

export interface RankSuccess {
  ok: true;
  ranked: RankedCandidate[];
  /** Probability the answer is in the candidate set at all. */
  present: number;
  /** Derived noul confidence, |p - 0.5| * 2. */
  presentConfidence: number;
  considered: number;
  /** True when the candidate list was cut to the configured ceiling. */
  truncated: boolean;
  rounds: number;
  calls: number;
}

export type RankOutcome = RankSuccess | { ok: false; error: JevFailure };

export interface RankDeps {
  ask?: typeof realAsk;
  /** Read a bounded head of a file. Returns a marker string when unreadable. */
  readHead?: (path: string, maxBytes: number) => string;
}

/** Ids may be echoed straight back into a choice label, so keep them boring. */
const ID_SAFE = /^[A-Za-z0-9_.:-]{1,16}$/;

/**
 * Give every candidate a short, unique, option-safe id.
 *
 * A caller-supplied id is kept when it is safe and unused, because Claude
 * correlates the result with its own list by that id. Anything else gets a
 * positional id, and a positional id that clashes with a caller id gets a
 * suffix — so the mapping id -> candidate stays a bijection no matter what
 * arrives.
 */
export function assignIds(candidates: readonly RankCandidate[]): string[] {
  const taken = new Set<string>();
  const ids: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const proposed = candidates[i]?.id;
    let id = proposed && ID_SAFE.test(proposed) && !taken.has(proposed) ? proposed : `f${i}`;
    let suffix = 0;
    while (taken.has(id)) id = `f${i}_${++suffix}`;
    taken.add(id);
    ids.push(id);
  }
  return ids;
}

export interface BatchLimits {
  maxPerBatch: number;
  maxBytesPerBatch: number;
}

/**
 * Split candidates into batches that respect both the option ceiling and the
 * context ceiling, greedily and in order.
 *
 * An entry that is on its own larger than the byte budget still gets a batch,
 * rather than being dropped: losing a candidate silently is worse than one
 * oversized request, and snippets are already bounded upstream.
 */
export function batchCandidates<T extends { path: string; snippet: string }>(
  entries: readonly T[],
  limits: BatchLimits,
): T[][] {
  const maxPerBatch = Math.max(1, Math.floor(limits.maxPerBatch));
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;

  for (const entry of entries) {
    const size = Buffer.byteLength(entry.snippet, "utf8") + Buffer.byteLength(entry.path, "utf8");
    const full = current.length >= maxPerBatch || (current.length > 0 && bytes + size > limits.maxBytesPerBatch);
    if (full) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export interface MergedEntry {
  id: string;
  score: number;
  rounds: number;
}

/**
 * Fold the per-round score maps into one global order.
 *
 * Surviving a round always outranks a high score in an earlier round: a
 * candidate that beat its batch and then beat the other batches' winners has
 * been compared against more of the field than one that only ever beat 23
 * neighbours. Ties break on the later-round probability, then on id so the
 * output is deterministic.
 */
export function mergeRounds(rounds: ReadonlyArray<Record<string, number>>): MergedEntry[] {
  const merged = new Map<string, MergedEntry>();

  rounds.forEach((scores, index) => {
    for (const [id, score] of Object.entries(scores)) {
      const value = Number.isFinite(score) ? score : 0;
      merged.set(id, { id, score: value, rounds: index + 1 });
    }
  });

  return [...merged.values()].sort(
    (a, b) => b.rounds - a.rounds || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Read the first `maxBytes` of a file without pulling the whole thing in. */
export function readHead(path: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch (err) {
    return `(unreadable: ${(err as Error)?.message ?? "unknown error"})`;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do; the descriptor dies with the process anyway.
      }
    }
  }
}

function choiceProbabilities(answers: Record<string, Answer>): Record<string, number> | undefined {
  const best = answers.best;
  if (!best || best.type !== "choice") return undefined;
  return (best as ChoiceAnswer).probabilities ?? {};
}

function presentAnswer(answers: Record<string, Answer>): NoulAnswer | undefined {
  const present = answers.present;
  return present && present.type === "noul" ? present : undefined;
}

/** Bounded-concurrency map. Batches are independent, but the API is not free. */
async function mapPooled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

interface BatchOutcome {
  scores: Record<string, number>;
  present: NoulAnswer | undefined;
  failure?: JevFailure;
}

async function rankBatch(
  query: string,
  batch: readonly BatchEntry[],
  ask: typeof realAsk,
): Promise<BatchOutcome> {
  const result: JevResult<Record<string, Answer>> = await ask({
    capability: "rank",
    state: buildState(query, batch),
    questions: buildQuestions(batch),
  });

  if (!result.ok) return { scores: {}, present: undefined, failure: result.error };

  const present = presentAnswer(result.answers);
  const probabilities = choiceProbabilities(result.answers);
  const scores: Record<string, number> = {};

  if (probabilities) {
    for (const entry of batch) {
      const p = probabilities[entry.id];
      scores[entry.id] = typeof p === "number" && Number.isFinite(p) ? p : 0;
    }
  } else {
    // A batch of one has no choice question to answer: the presence noul is the
    // only evidence about it, so it becomes that candidate's score.
    for (const entry of batch) scores[entry.id] = present?.noul ?? 0;
  }

  return { scores, present };
}

/**
 * Rank candidates against a query.
 *
 * Never throws and never invents a ranking: any Jev failure in any batch
 * propagates out as `{ok: false}` so the caller can say so and fall back to
 * reading files.
 */
export async function rankCandidates(request: RankRequest, deps: RankDeps = {}): Promise<RankOutcome> {
  const ask = deps.ask ?? realAsk;
  const read = deps.readHead ?? readHead;
  const config = loadConfig();

  const topK = Math.max(
    1,
    Math.min(TUNING.maxTopK, Math.floor(request.topK ?? TUNING.defaultTopK)),
  );

  const truncated = request.candidates.length > config.rank.maxCandidates;
  const kept = request.candidates.slice(0, config.rank.maxCandidates);

  if (kept.length === 0) {
    // Nothing to point at. Reporting absence without asking is honest here: an
    // empty set provably does not contain the answer.
    return {
      ok: true,
      ranked: [],
      present: 0,
      presentConfidence: 1,
      considered: 0,
      truncated,
      rounds: 0,
      calls: 0,
    };
  }

  const ids = assignIds(kept);
  const entries: BatchEntry[] = kept.map((candidate, index) => {
    const raw = candidate.snippet ?? read(candidate.path, TUNING.maxSnippetBytes * 2);
    // Everything that leaves the machine goes through prepare(): redact first,
    // then bound. Caller-supplied snippets are no more trusted than file reads.
    return {
      id: ids[index] ?? `f${index}`,
      path: candidate.path,
      snippet: prepare(raw, TUNING.maxSnippetBytes).text,
    };
  });

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const limits: BatchLimits = {
    maxPerBatch: Math.min(TUNING.maxCandidatesPerBatch, TUNING.maxOptionsPerChoice),
    maxBytesPerBatch: TUNING.maxBatchContentBytes,
  };

  const roundScores: Array<Record<string, number>> = [];
  let pool: BatchEntry[] = entries;
  let present: NoulAnswer | undefined;
  let calls = 0;

  for (let round = 0; round < TUNING.maxRounds; round++) {
    const batches = batchCandidates(pool, limits);
    const outcomes = await mapPooled(batches, 4, (batch) => rankBatch(request.query, batch, ask));
    calls += batches.length;

    const failed = outcomes.find((outcome) => outcome.failure);
    if (failed?.failure) return { ok: false, error: failed.failure };

    const scores: Record<string, number> = {};
    for (const outcome of outcomes) Object.assign(scores, outcome.scores);
    roundScores.push(scores);

    // Presence is taken from the LAST round, overwriting earlier rounds, rather
    // than maxed across every batch of every round. A maximum over 17
    // independent nouls drifts upward on noise alone, which would quietly
    // destroy the "not here" answer this tool exists for. The final round is a
    // single batch holding the strongest candidate from everywhere, so its noul
    // is one clean answer about the best of the field.
    present = pickPresent(outcomes) ?? present;

    if (batches.length <= 1) break;

    const finalists = promote(batches, scores, TUNING.finalistsPerBatch);
    if (finalists.length >= pool.length) break; // No progress; stop rather than loop.
    pool = finalists;
  }

  const merged = mergeRounds(roundScores);
  const ranked: RankedCandidate[] = [];
  for (const entry of merged) {
    const candidate = byId.get(entry.id);
    if (!candidate) continue;
    ranked.push({ id: entry.id, path: candidate.path, score: entry.score, rounds: entry.rounds });
    if (ranked.length >= topK) break;
  }

  return {
    ok: true,
    ranked,
    present: present?.noul ?? 0,
    presentConfidence: present?.confidence ?? 0,
    considered: entries.length,
    truncated,
    rounds: roundScores.length,
    calls,
  };
}

/**
 * Presence within one round. "Is it anywhere in these files" is an existence
 * claim over disjoint subsets, so the strongest yes wins.
 *
 * This only decides the reported value when the loop stops while still
 * multi-batch (the round ceiling, or a no-progress stop). The normal path ends
 * on a single final batch, where this returns that one answer untouched.
 */
function pickPresent(outcomes: readonly BatchOutcome[]): NoulAnswer | undefined {
  let best: NoulAnswer | undefined;
  for (const outcome of outcomes) {
    const p = outcome.present;
    if (!p) continue;
    if (!best || p.noul > best.noul) best = p;
  }
  return best;
}

/** Top `perBatch` candidates of each batch, in their original batch order. */
function promote(
  batches: readonly BatchEntry[][],
  scores: Record<string, number>,
  perBatch: number,
): BatchEntry[] {
  const promoted: BatchEntry[] = [];
  for (const batch of batches) {
    const ordered = [...batch].sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0));
    promoted.push(...ordered.slice(0, perBatch));
  }
  return promoted;
}
