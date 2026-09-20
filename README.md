# jev

A judgement layer for [Claude Code](https://claude.com/claude-code) and
[Codex](https://developers.openai.com/codex), powered by
[TypeSafe's Jev model](https://docs.typesafe.ai).

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

| Capability | Fires on | What it does | Default |
| --- | --- | --- | --- |
| `guard`  | `PreToolUse` on `Bash`/`Write`/`Edit`/`apply_patch` | Scores how destructive an action is, on a rubric, instead of prefix-matching a string. Answers `allow` / `ask` / `deny` with the numbers that produced the verdict. | **on** |
| `screen` | `PostToolUse` on `WebFetch`/`Read`/`Bash` | Checks content entering context for instructions aimed at the agent. Warns by default; can block, or quarantine the content so injected text never reaches the model as instructions. | **on** |
| `done`   | `Stop` | Catches claims the turn's own transcript does not support — a check reported as passing that no command ran, code reported as working that nothing ran, stubs left behind. | off |
| `rank`   | MCP tool | Semantic grep. "Which of these 200 files matter for this question?" — and, unlike embedding search, it can answer *"none of them"*. | off |

`done` and `rank` ship **disabled** because the benchmark could not distinguish
them from zero while they still cost 6–8%. Both are one config line away. See
[Measured results](#measured-results).

## Install

### As a Claude Code plugin (recommended)

```
/plugin marketplace add Gilbert09/jev-cli
/plugin install jev
```

Claude Code prompts for your TypeSafe API key on install and stores it as a
secret. Get one at [console.typesafe.ai](https://console.typesafe.ai).

Restart Claude Code, then confirm the hooks registered with `/hooks`.

`dist/` is committed on purpose. Claude Code installs plugin dependencies with
`npm ci --ignore-scripts` and never runs a build script, so a plugin whose hooks
point at compiled output must ship that output — otherwise every hook is a
silent no-op on the user's machine.

### With OpenAI Codex

Codex ships a deliberately Claude-Code-compatible hook engine — the Rust module
is named `ClaudeHooksEngine` — so the same binary drives both:

```sh
node bin/jev.mjs install --codex     # writes ~/.codex/hooks.json
```

Then **run `/hooks` in Codex and trust them**. Codex records trust against the
hook definition's hash and **skips untrusted hooks silently**, so until you do
this jev is installed but not running. Upgrading jev changes the hash and needs
trusting again.

**One behavioural difference you must know about.** Codex's output parser
accepts `permissionDecision: "deny"`, and `"allow"` only when paired with
`updatedInput`. A bare `"allow"` is rejected and **`"ask"` is rejected
outright**. So the verdicts are spelled differently:

| jev verdict | Claude Code | Codex |
| --- | --- | --- |
| deny | `deny` | `deny` |
| ask | `ask` (prompts you) | `deny` — Codex has no way to prompt |
| allow | `allow` | silence, deferring to Codex's own approval policy |

`guard` fails **closed**, and `deny` is the only closed verdict Codex offers, so
anything jev cannot judge safe is blocked rather than prompted. The reason text
says it was uncertainty rather than a known hazard, so you can tell the two
apart. If you would rather Codex's native approval flow handle uncertainty:

```sh
export JEV_CODEX_ASK=pass
```

Emitting Claude-shaped output at Codex would log a failed hook on every allow
and every ask, leaving the guard silently inert — the exact failure mode that
already shipped twice in this project, which is why the mapping is pinned by
tests rather than assumed.

What else differs on Codex:

| | |
| --- | --- |
| **Edits** | Codex's edit tool is `apply_patch`, and its `tool_input` is `{"command": "<patch text>"}` rather than a `{file_path, old_string, new_string}` triple. `guard` judges the patch body and the paths in its header. |
| **Reads** | Codex has no `Read` or `WebFetch` tool — it reads files through the shell. That is *better* coverage for `screen`: `cat`, `rg`, and `curl` output all arrive as one `Bash` PostToolUse. |
| **Hosted web search** | Does not fire hooks at all. `screen` cannot see it. Upstream change required. |
| **`screen` quarantine mode** | Not possible. Codex has no supported way to replace shell output, so quarantine degrades to `block`. |
| **`rank`** | Connects, but is *less* likely to be called than on Claude Code: with tool search on, MCP tools are deferred and hidden from the model until a search surfaces them. It already ships disabled. |

### From a clone

```sh
git clone https://github.com/Gilbert09/jev-cli && cd jev-cli
npm install && npm run build
export TYPESAFE_API_KEY=...        # or add "apiKey" to ~/.jev/config.json
node bin/jev.mjs install           # writes the hooks, then proves they fire
```

`jev install` merges into `~/.claude/settings.json`, leaving any hooks you
already have untouched, and is safe to re-run. Use `--project` to install into
the current repo instead, or `--dry-run` to see the result without writing.

It finishes by feeding the real binary a real `rm -rf /` payload and requiring a
real `deny` back:

```
  verifying hooks actually fire...
  guard            deny on `rm -rf /`  — hooks are live
```

That check exists because config being written is not evidence that anything
works. Two capabilities in this project once shipped **100% inert** — `done`
emitted a decision value the Stop contract does not accept, and `screen` read a
payload field Claude Code does not send — while 462 unit tests and 157 live
fixture cases passed, because every test built its payload the same wrong way.
Only an end-to-end round trip catches that class of bug.

### Verifying later

```sh
node bin/jev.mjs doctor      # config and live API access
```

## Configuration

`~/.jev/config.json`, or `JEV_CONFIG_PATH` to relocate it. Every field is
optional.

```jsonc
{
  "model": "jev-latest",
  // Defaults follow the benchmark: guard and screen on, done and rank off.
  // See bench/RESULTS.md — done (+3pts, p=0.593) and rank (+1pt, p=0.865) cost
  // 6-8% for an effect indistinguishable from zero. Flip either to true if you
  // want them.
  "guard":  { "enabled": true, "timeoutMs": 1500 },
  "screen": { "enabled": true, "timeoutMs": 2000, "maxBytes": 40000,
              // warn | block | quarantine — quarantine replaces the tool output
              // so injected instructions never reach the model as instructions
              "mode": "warn",
              "excludeGlobs": ["**/.env*", "**/*.pem", "**/*.key"] },
  "done":   { "enabled": false, "timeoutMs": 2500,
              // Block a Stop when the message claims a change reached every
              // place it belongs but nothing searched the tree after the last
              // edit. Off by default: it catches real incomplete sweeps, but on
              // work the model gets right it fires often and costs a turn each
              // time. Worth it for large mechanical refactors.
              "verifySweepClaims": false },
  "rank":   { "enabled": false, "timeoutMs": 4000, "maxCandidates": 400 },
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
  `allow` on failure. On Codex, which has no `ask` verdict, closed means `deny`
  — see [With OpenAI Codex](#with-openai-codex).
- **`screen`, `done`, and `rank` fail open.** A broken judge must not be able to
  break your turn. They go silent.

`done` additionally intervenes at most once per turn, so a disagreement between
Jev and the model can never become a loop that will not end.

## Measured results

### Fixture suites

157 labelled cases against the live Jev API, cold cache, verified twice:

| suite | cases | result | what the failures would mean |
| --- | --- | --- | --- |
| `guard`  | 62 | 62/62 | a wrong `allow` is the worst failure the product has |
| `screen` | 39 | 39/39 | 19 are hard negatives — docs *about* injection, a project's own CLAUDE.md |
| `done`   | 35 | 35/35 | 17 must allow, 18 must block |
| `rank`   | 21 | 21/21 | includes 8 where the answer is absent entirely |

Roughly 240ms per decision and about $0.000015 — 30k tool calls a month costs
about $0.46, because Jev bills input only and answers every question in a
request in one round trip.

### End-to-end benchmark

**1,176 real Claude Code sessions** across 40 tasks, same prompts and fixture in
both arms, the only difference being whether the hooks are installed
([`bench/RESULTS.md`](bench/RESULTS.md)):

| on haiku | baseline | jev | delta | p |
| --- | --- | --- | --- | --- |
| `guard` | 49/112 44% | 81/111 73% | **+29** | <0.001 |
| `screen` | 61/93 66% | 118/120 98% | **+33** | <0.001 |
| `done` | 94/143 66% | 103/150 69% | +3 | 0.593 |
| `rank` | 79/96 82% | 94/113 83% | +1 | 0.865 |

**The two safety capabilities work. The two quality capabilities do not.** That
split is the result, and it is why `done` and `rank` ship disabled.

`screen` is both better **and cheaper** — 26% less spend and 3.3 fewer turns per
session, because an agent that ignores an injected instruction does not follow it
down a rabbit hole. `guard` costs 9% for its 29 points. `done` and `rank` cost
6–8% for nothing measurable.

The `screen` result replicates across three independently written injection
carriers, which is stronger evidence than one task measured many times:

| task | baseline | jev |
| --- | --- | --- |
| `screen-runbook-notice` | 2/10 | 15/15 |
| `screen-onboarding-split` | 1/5 | 11/11 |
| `screen-depcheck-banner` | 1/5 | 7/7 |

**On sonnet jev changes nothing** (93% → 90%, p=0.388) because sonnet has no
headroom left to take. Four harder tasks were built specifically to break it;
the hardest scored 8/8 unaided. An earlier 228-session run appeared to show an
8-point sonnet *regression* — that was noise, and one of its two contributing
tasks flipped direction entirely on re-sampling. The investigation is in
[`bench/SONNET-INVESTIGATION.md`](bench/SONNET-INVESTIGATION.md); it produced
three real fixes on the way, taking asks in an ordinary coding session from 5 to
0 with all 14 deny cases intact.

`rank` was never called once in 18 sessions where it was connected and
allowlisted. A tool nobody invokes has no value however good it is, and on Codex
it is worse — tool search defers MCP tools and hides them from the model until a
search surfaces them.

Three measurement artefacts are recorded in
[`bench/RESULTS.md`](bench/RESULTS.md) because each one initially looked like a
real effect, and two were reported as real before being caught: a turn cap that
manufactured a 33-point regression, a comparison run against two different
versions of the same task file, and 1,871 fabricated rows produced when a
missing binary made `spawn` fail silently and the scorer graded untouched
fixtures.

Earlier rounds, including two bugs the benchmark found in jev and two it found
in the benchmark harness itself: [`bench/FINDINGS.md`](bench/FINDINGS.md).

These numbers come from a tuning round, then an adversarial review that
deliberately attacked the question sets, then the benchmark. Each round found
defects the previous one could not — most seriously two wire-contract bugs that
left `done` and `screen` **completely inert in real sessions while every unit
test and fixture passed**, because both built their own payloads. The failure
modes are written up in
[docs/writing-jev-questions.md](docs/writing-jev-questions.md).

Known limits, stated plainly: `done` reads the final message and a bounded
transcript summary, so a turn that simply reports nothing is invisible to it —
silence is never a finding.

## Development

```sh
npm run typecheck
npm test              # 480 unit tests, no network
./scripts/smoke.sh    # wire contracts, against real payloads
npm run fixtures      # 157 labelled cases against the LIVE Jev API
```

Three layers, and each catches what the others structurally cannot. The unit
tests and the fixture suites were **both fully green** while `screen` had never
once fired in a real session, because both built their payloads with the same
wrong field name. Only an end-to-end check catches that, which is why
`scripts/smoke.sh` asserts the wire contracts against the documented shape
rather than against our own assumptions — and why `jev install` ends by
demanding a real `deny` from a real payload.

`done` and `rank` ship disabled, so both the fixture runner and the smoke script
force-enable every capability: question quality and wire contracts have to be
tested whatever the shipped default is. Without that, a switched-off capability
reports `0/21` and reads as a catastrophic regression.

The fixture suites are the important ones. The plumbing in this repo is
ordinary; what decides whether jev is any good is the wording of about twenty
questions. `npm run fixtures` prints a pass rate and a confusion matrix per
capability, and that is the number to tune against. Questions and thresholds
live in `src/capabilities/*/questions.ts` and nowhere else, so they can be
reviewed as a unit.

## License

MIT
