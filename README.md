# jev

A judgement layer for Claude Code, powered by [TypeSafe's Jev model](https://docs.typesafe.ai).

Jev is a "System One" model. It cannot write code or prose — it answers **typed
questions** about state and returns bounded answers with calibrated
probabilities. That makes it the wrong tool for generating anything and an
unusually good tool for the decisions an agent harness makes hundreds of times
a session.

## Why not just use a prompt hook?

Claude Code already supports `type: "prompt"` hooks, which hand a decision to a
Haiku call that returns `{ok, reason}`. For a hook that fires on **every tool
call**, Jev is a better fit:

|                | `type: "prompt"` hook | `jev` |
| -------------- | --------------------- | ----- |
| Latency        | ~1–3s per decision    | sub-second |
| Cost           | tokens in *and* out   | $42 per billion input tokens, output free |
| Output         | one boolean + prose   | many questions answered in parallel, each with a probability distribution |
| Calibration    | none                  | `confidence` is a first-class output you threshold on |
| Failure mode   | can emit anything     | type-safe — cannot return a value outside the schema |

## What it does

| Capability | Fires on | What it does |
| ---------- | -------- | ------------ |
| `guard`  | `PreToolUse` on `Bash`/`Write`/`Edit` | Scores how destructive an action is, on a rubric, instead of prefix-matching a string. Answers `allow` / `ask` / `deny` with the numbers that produced the verdict. |
| `screen` | `PostToolUse` on `WebFetch`/`Read`/`Bash` | Checks content entering context for instructions aimed at the agent. Warns; never blocks. |
| `done`   | `Stop` | Catches claims the turn's own transcript does not support — a check reported as passing that no command ran, code reported as working that nothing ran, stubs left behind. |
| `rank`   | MCP tool | Semantic grep. "Which of these 200 files matter for this question?" — and, unlike embedding search, it can answer *"none of them"*. |

## Install

```sh
npm install && npm run build
```

Then point Claude Code at the directory as a plugin, and set your key:

```sh
export TYPESAFE_API_KEY=...   # or add "apiKey" to ~/.jev/config.json
node bin/jev.mjs doctor       # verifies config and live API access
```

## Configuration

`~/.jev/config.json`, or `JEV_CONFIG_PATH` to relocate it. Every field is
optional.

```jsonc
{
  "model": "jev-latest",
  "guard":  { "enabled": true, "timeoutMs": 1500 },
  "screen": { "enabled": true, "timeoutMs": 2000, "maxBytes": 40000,
              "excludeGlobs": ["**/.env*", "**/*.pem", "**/*.key"] },
  "done":   { "enabled": true, "timeoutMs": 2500 },
  "rank":   { "enabled": true, "timeoutMs": 4000, "maxCandidates": 400 },
  "debug":  false
}
```

`JEV_DEBUG=1` writes decision traces to stderr; Claude Code shows them under
`claude --debug`.

## What leaves your machine

Be deliberate about this.

- **`guard`** sends the command or file path being judged, plus the working
  directory and repo root. Not file contents.
- **`screen`** sends the content it is screening — fetched pages, file contents,
  command output. That is the point of it, and it is the most invasive
  capability here.
- **`done`** sends the assistant's final message and a bounded summary of the
  turn drawn from the transcript.
- **`rank`** sends candidate paths and short excerpts of their contents.

Before anything is sent it passes through a redaction pass that strips
credential-shaped strings: provider API keys, GitHub and Slack tokens, AWS key
IDs, PEM private key blocks, JWTs, and `SECRET=`/`TOKEN=`-style assignments.
`screen` additionally refuses to read paths matching `excludeGlobs`.

Redaction is defence in depth, not a guarantee. If you work with content that
must not reach a third party, disable `screen` and `rank`:

```jsonc
{ "screen": { "enabled": false }, "rank": { "enabled": false } }
```

## How it fails

Each capability has a deliberate failure direction, and both are tested:

- **`guard` fails closed.** Timeout, missing key, API error, anything — it
  answers `ask`. A judge that cannot judge defers to you. It never answers
  `allow` on failure.
- **`screen`, `done`, and `rank` fail open.** A broken judge must not be able to
  break your turn. They go silent.

`done` additionally intervenes at most once per turn, so a disagreement between
Jev and the model can never become a loop that will not end.

## Measured results

Against the live Jev API, cold cache, two consecutive runs — 157 cases total:

| suite | cases | result | what the failures would mean |
| --- | --- | --- | --- |
| `guard`  | 62 | 62/62 | a wrong `allow` is the worst failure the product has |
| `screen` | 39 | 39/39 | 19 are hard negatives — docs *about* injection, a project's own CLAUDE.md |
| `done`   | 35 | 35/35 | 17 must allow, 18 must block |
| `rank`   | 21 | 21/21 | includes 8 where the answer is absent entirely |

Roughly 240ms per decision (p50), and about $0.000015 — 30k tool calls a month
costs about $0.46, because Jev bills input only and answers every question in a
request in one round trip.

These numbers come from a tuning round followed by an adversarial review that
deliberately attacked the question sets. The review found three critical defects
the passing suites could not have caught, including a `done` output shape Claude
Code silently ignored — every intervention was a no-op, and the tests asserted
the shape this repo had invented rather than the documented one. The failure
modes from both rounds are written up in
[docs/writing-jev-questions.md](docs/writing-jev-questions.md).

Known limits, stated plainly: `done` reads the final message and a bounded
transcript summary, so a turn that simply reports nothing is invisible to it —
silence is never a finding.

## Development

```sh
npm run typecheck
npm test              # unit tests, no network
npm run fixtures      # labelled suites against the LIVE Jev API
```

The fixture suites are the important ones. The plumbing in this repo is
ordinary; what decides whether jev is any good is the wording of about twenty
questions. `npm run fixtures` prints a pass rate and a confusion matrix per
capability, and that is the number to tune against. Questions and thresholds
live in `src/capabilities/*/questions.ts` and nowhere else, so they can be
reviewed as a unit.

## License

MIT
