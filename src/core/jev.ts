import { TypeSafeClient } from "@typesafe-ai/sdk";
import { cacheGet, cacheKey, cacheSet } from "./cache.js";
import { loadConfig } from "./config.js";
import { debug } from "./log.js";
import { noulConfidence, validateScore } from "./decide.js";
import type { Answer, JevFailure, JevResult } from "./types.js";

/**
 * The single point of contact with the Jev API.
 *
 * Contract for capability handlers: `ask` NEVER throws and NEVER blocks longer
 * than the capability's configured timeout. Every failure is returned as a
 * typed `JevFailure` so the handler can apply its own safe default — fail
 * closed for `guard`, fail open for everything else.
 */

export type Capability = "guard" | "screen" | "done" | "rank";

/** Question objects as produced by the SDK's `noul()` / `choice()` / `score()`. */
export type QuestionMap = Record<string, unknown>;

let client: TypeSafeClient | undefined;

function getClient(apiKey: string): TypeSafeClient {
  client ??= new TypeSafeClient({ apiKey });
  return client;
}

/** Map a raw SDK answer onto our normalised `Answer` union. */
function normalizeAnswer(key: string, raw: unknown): Answer {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`answer "${key}" is not an object`);
  }
  const a = raw as Record<string, unknown>;

  if (typeof a.noul === "number") {
    // NoulResponse has no confidence field; derive one from the probability.
    return { type: "noul", noul: a.noul, confidence: noulConfidence(a.noul) };
  }

  if (typeof a.score === "number") {
    const probabilities = (a.probabilities ?? {}) as Record<string, number>;
    const legend = (a.legend ?? {}) as Record<string, unknown>;
    // The rubric size is recoverable from the per-level probability map, so
    // callers never declare it twice and it can never drift from the question.
    const levels = Object.keys(probabilities).length;
    if (levels < 2) {
      throw new Error(`score answer "${key}" returned ${levels} level probabilities`);
    }
    const score = validateScore(a.score, levels);
    return {
      type: "score",
      score,
      nearest: Math.round(score),
      levels,
      probabilities,
      legend,
      confidence: typeof a.confidence === "number" ? a.confidence : 0,
    };
  }

  if (typeof a.choice === "string") {
    return {
      type: "choice",
      choice: a.choice,
      probabilities: (a.probabilities ?? {}) as Record<string, number>,
      confidence: typeof a.confidence === "number" ? a.confidence : 0,
    };
  }

  throw new Error(`answer "${key}" has no noul, score, or choice field`);
}

function toFailure(err: unknown): JevFailure {
  const e = err as { status?: number; message?: string; name?: string };
  if (e?.name === "AuthenticationError" || e?.status === 401) {
    return { type: "api_error", status: 401, message: "authentication failed" };
  }
  if (typeof e?.status === "number") {
    return { type: "api_error", status: e.status, message: e.message ?? "request failed" };
  }
  return { type: "api_error", message: e?.message ?? String(err) };
}

export interface AskOptions {
  capability: Capability;
  /** Arbitrary JSON state. Redact anything untrusted before passing it here. */
  state: unknown;
  questions: QuestionMap;
  /** Skip the cache — used by the fixture runner to measure real behaviour. */
  noCache?: boolean;
}

export async function ask<T extends Record<string, Answer>>(
  opts: AskOptions,
): Promise<JevResult<T>> {
  const started = Date.now();
  const config = loadConfig();
  const capConfig = config[opts.capability];

  const fail = (error: JevFailure): JevResult<T> => {
    debug(opts.capability, { error });
    return { ok: false, error, ms: Date.now() - started };
  };

  if (!capConfig.enabled) return fail({ type: "disabled" });
  if (!config.apiKey) return fail({ type: "no_api_key" });

  const key = cacheKey([config.model, opts.capability, opts.questions, opts.state]);
  if (!opts.noCache) {
    const hit = cacheGet<T>(key);
    if (hit) {
      debug(opts.capability, { cached: true, ms: Date.now() - started });
      return { ok: true, answers: hit, cached: true, ms: Date.now() - started };
    }
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    // Bound the call two ways: the SDK's own per-attempt timeout plus an abort
    // signal, so retries inside the SDK cannot outlive our budget either.
    timer = setTimeout(() => controller.abort(), capConfig.timeoutMs);

    const response = (await getClient(config.apiKey).systemOne(
      {
        model: config.model,
        state: opts.state as never,
        questions: opts.questions as never,
      },
      { signal: controller.signal, timeout: capConfig.timeoutMs },
    )) as { answers?: Record<string, unknown> };

    if (!response?.answers) return fail({ type: "malformed", message: "no answers field" });

    const answers: Record<string, Answer> = {};
    for (const [k, v] of Object.entries(response.answers)) {
      answers[k] = normalizeAnswer(k, v);
    }

    if (!opts.noCache) cacheSet(key, answers);
    const ms = Date.now() - started;
    debug(opts.capability, { cached: false, ms, answers });
    return { ok: true, answers: answers as T, cached: false, ms };
  } catch (err) {
    const name = (err as Error)?.name;
    if (controller.signal.aborted || name === "APITimeoutError" || name === "APIUserAbortError") {
      return fail({ type: "timeout", ms: capConfig.timeoutMs });
    }
    if (err instanceof RangeError || (err as Error)?.message?.includes("answer ")) {
      return fail({ type: "malformed", message: (err as Error).message });
    }
    return fail(toFailure(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
