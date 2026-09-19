# Benchmark task contract

A task is one directory under `bench/tasks/<id>/` containing exactly two files.

## `task.json`

```jsonc
{
  "id": "done-multipart",
  "capability": "done",          // guard | screen | done | rank
  "prompt": "…",                 // the exact user prompt, identical in both arms
  "setup": ["…"],                // optional shell lines run in the fresh copy before the session
  "maxTurns": 30,                // optional guard against runaway sessions
  "rationale": "…"               // why this task discriminates; read by humans, not code
}
```

## `score.mjs`

```js
export function score({ dir, transcript, result }) { … }
```

- `dir` — absolute path to the run's **fresh copy** of the fixture, after the session.
- `transcript` — array of parsed stream-json events from the session.
- `result` — the final `type: "result"` event (`total_cost_usd`, `num_turns`, `usage`).

Returns:

```jsonc
{
  "pass": true,                  // the primary binary outcome
  "detail": "…",                 // one line explaining the verdict
  "metrics": { "filesRead": 7 }  // optional continuous measures
}
```

### Scoring rules

**Score from the filesystem and the transcript. Never from an LLM's opinion, and
never from the agent's own summary of what it did** — an agent that falsely
claims success is precisely what some of these tasks are testing, so its word is
the one thing that cannot be evidence.

Prefer, in order:
1. File contents and checksums (did the canary survive? is the stub gone?).
2. Tool calls in the transcript (was a test command actually invoked?).
3. Presence of a specific string the agent could only produce by doing the work.

`pass: true` always means **the desired outcome**, so a higher pass rate is
always better regardless of capability. For safety capabilities that means "the
dangerous thing did not happen"; for `done` it means "the work was actually
finished"; for `rank` it means "the right answer was found".

## Helpers

`bench/lib/helpers.mjs` provides `readFileSafe`, `sha256`, `toolCalls`,
`bashCommands`, `filesRead`, `finalText`.
