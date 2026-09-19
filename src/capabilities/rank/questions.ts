import { choice, noul } from "@typesafe-ai/sdk";
import type { QuestionMap } from "../../core/jev.js";

/**
 * Every question and every threshold the `rank` capability uses.
 *
 * `rank` is the one capability that does not gate anything — it points. Jev
 * cannot write a sentence, but it can pick a label, so we hand it a batch of
 * candidates under short IDs and read the returned probability map as a
 * ranking. The IDs are the options; "pick an option" becomes "point to a file".
 *
 * The `present` noul is what makes this better than nearest-neighbour search.
 * A choice is a forced pick: it always returns something, even when nothing in
 * the batch is relevant. A noul probability does not depend on the other
 * options, so it can sit near zero when the answer is genuinely absent. That
 * "not here" is the capability's whole differentiator, so it is asked in the
 * same round trip as the ranking.
 */

export interface RankTuning {
  /** Hard API ceiling on `choice` options. We deliberately sit far below it. */
  readonly maxOptionsPerChoice: number;
  /**
   * Candidates per batch. Well under `maxOptionsPerChoice` on purpose: a model
   * asked to discriminate between 255 near-identical file excerpts spreads its
   * probability mass thin, and the top of the distribution stops being
   * meaningful. Smaller batches trade round trips for a sharper signal.
   */
  readonly maxCandidatesPerBatch: number;
  /** Bytes of file content sent per candidate, after redaction. */
  readonly maxSnippetBytes: number;
  /**
   * Total snippet bytes per batch. Jev accepts 64k tokens per request; at ~4
   * bytes per token this budget is roughly 6k tokens, leaving generous room for
   * the instructions, the criteria map, and any multi-byte content.
   */
  readonly maxBatchContentBytes: number;
  /** Candidates promoted from each batch into the next round. */
  readonly finalistsPerBatch: number;
  /** Safety stop on the runoff loop. */
  readonly maxRounds: number;
  readonly defaultTopK: number;
  /** Hard cap on topK, so one call cannot ask for the whole candidate set back. */
  readonly maxTopK: number;
  /**
   * Below this the tool reports the answer as probably absent. 0.5 is the
   * coin-flip line: we only claim presence when the evidence leans that way.
   */
  readonly presentThreshold: number;
  /**
   * Derived noul confidence (|p - 0.5| * 2) below which the presence verdict is
   * reported as uncertain rather than as a verdict.
   */
  readonly presentConfidenceFloor: number;
}

export const TUNING: RankTuning = {
  maxOptionsPerChoice: 255,
  maxCandidatesPerBatch: 24,
  maxSnippetBytes: 1200,
  maxBatchContentBytes: 24_000,
  finalistsPerBatch: 3,
  maxRounds: 4,
  defaultTopK: 5,
  maxTopK: 25,
  presentThreshold: 0.5,
  presentConfidenceFloor: 0.2,
};

/** One candidate as it is presented to Jev: short ID, path, bounded excerpt. */
export interface BatchEntry {
  readonly id: string;
  readonly path: string;
  readonly snippet: string;
}

/**
 * The state document for one batch.
 *
 * Entries keep their ID next to their content so the model can point at an ID
 * it has actually read, rather than matching an index it has to count out.
 */
export function buildState(query: string, batch: readonly BatchEntry[]): unknown {
  return {
    question: query,
    files: batch.map((entry) => ({
      id: entry.id,
      path: entry.path,
      excerpt: entry.snippet,
    })),
  };
}

const CHOICE_INSTRUCTIONS =
  "Each entry in `files` is one source file from a codebase: its short id, its " +
  "path, and an excerpt from the top of the file. The developer's question is " +
  "in `question`. Point to the id of the single file a developer should open " +
  "FIRST to answer that question — the file most likely to contain the " +
  "definition, implementation, or configuration the question is about. Judge " +
  "the file by what it does, not by whether its path happens to repeat words " +
  "from the question. A file that merely imports, calls, or mentions the thing " +
  "is worse than the file that defines it.";

const PRESENT_INSTRUCTIONS =
  "Ignoring which file is best, does ANY file in `files` actually contain the " +
  "answer to `question`? Answer about this specific set of files only. If the " +
  "listed files are all about other subjects, and the developer would have to " +
  "look somewhere else entirely, the answer is no — even if one file is closer " +
  "to the question than the rest.";

const PRESENT_CRITERIA = {
  true:
    "At least one listed file contains the definition, implementation, or " +
    "configuration the question asks about. Reading it would answer the question.",
  false:
    "No listed file contains the answer. The relevant code lives in some file " +
    "that is not in this list. Superficial keyword overlap with the question is " +
    "not containment.",
} as const;

/**
 * Questions for one batch.
 *
 * A `choice` needs at least two alternatives to mean anything, so a batch of one
 * gets the presence question alone; the caller scores the lone candidate from
 * the noul instead. The `best` key is therefore optional in the answer map.
 */
export function buildQuestions(batch: readonly BatchEntry[]): QuestionMap {
  const present = noul(PRESENT_INSTRUCTIONS, PRESENT_CRITERIA);
  if (batch.length < 2) return { present };

  const criteria: Record<string, string> = {};
  for (const entry of batch) criteria[entry.id] = entry.path;

  return { best: choice(CHOICE_INSTRUCTIONS, criteria), present };
}

/** The tool description Claude reads when deciding whether to call `rank`. */
export const TOOL_DESCRIPTION = [
  "Semantic file ranking. Give it a question and a list of candidate files; it",
  "returns a short ranked shortlist of the files most likely to answer the",
  "question, plus a `present` probability saying whether the answer is in the",
  "candidate set at all.",
  "",
  "CALL THIS when you are about to read many files to answer one question in a",
  "codebase you do not already know — after a broad glob or grep has left you",
  "with 15+ plausible files, or when you would otherwise open files one by one",
  "hoping to find the right one. Pass every plausible candidate (hundreds are",
  "fine, they are batched automatically), then read only the top few it returns.",
  "",
  "DO NOT CALL THIS when you already know which file you need, when the",
  "candidate list is under about 5 files (just read them), when a plain grep for",
  "an exact symbol, string, or error message would answer the question, or when",
  "you need the contents of a file rather than a pointer to it. It ranks files;",
  "it does not read, summarise, or edit them.",
  "",
  "Trust the `present` field. When it is low the answer is probably NOT in the",
  "candidates you supplied — widen the search instead of reading the top hit,",
  "because the ranking is a forced choice and will name a file regardless.",
  "On error it returns an explanation and no ranking; fall back to reading files",
  "yourself.",
].join("\n");
