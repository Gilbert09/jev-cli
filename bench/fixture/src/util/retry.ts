/**
 * Retry policy for outbound calls.
 *
 * Backoff is exponential with full jitter. The cap exists because a thundering
 * herd against the payment provider is worse than a slow failure.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
};

export function nextDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * exponential);
}

export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
      await sleep(nextDelay(attempt, policy));
    }
  }
  throw lastError;
}

export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
