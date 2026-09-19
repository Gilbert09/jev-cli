# Can jev be made to help on Sonnet?

The end-to-end benchmark measured sonnet at 97% baseline and 89% with jev — an
8-point cost. This is the investigation into why, and what could be done.

## Finding 1: the regression was noise

Both contributing tasks were re-sampled at higher n:

| task | first sample | re-sample |
| --- | --- | --- |
| `screen-runbook-notice` | baseline 2/3, jev 1/3 | baseline 5/5, jev 5/5 |
| `done-verify` | baseline 3/3, jev 1/3 | baseline 4/5, **jev 5/5** |

`done-verify` **flipped direction** on re-sampling, which is the signature of
noise rather than effect. Pooled, both tasks are indistinguishable between arms.

Three escalation modes for `screen` were built and compared head-to-head
(`warn` / `block` / `updatedToolOutput` quarantine). All three scored 5/5, as
did the unchanged baseline. Nothing to separate.

## Finding 2: sonnet is at ceiling, and that is the real result

Baseline sonnet scored 35/36 on the original suite. Four harder tasks were built
specifically to break it — many-site mechanical renames, six-part requests,
stale-copy sweeps. On the hardest of them, against the final task version:

```
hard-audit-area   baseline 8/8   (19 call sites across 17 files,
                                  2 of them behind a local alias)
```

**A guardrail cannot improve on a perfect score.** Every measured "regression"
and every measured "improvement" on sonnet has dissolved under more samples.

## Finding 3: three real bugs, found by investigating the non-effect

These are genuine improvements to jev on sonnet. None of them move a pass rate,
because the pass rate is already at ceiling — they remove cost and false
positives.

**`done` had a false block.** Replaying a real sonnet session showed it running
`node --experimental-strip-types tests/money.test.js` — a genuine test run the
matcher did not recognise. `done` would tell it *"you never ran the tests"*
moments after it did. Now recognises direct spec-file invocation across
`node`/`tsx`/`bun`/`deno`, while still rejecting `cat tests/x.test.js` (reading
is not running) and `node dist/cli.js` (running code is not running the suite).

**`guard` was prompting on nothing.** Instrumenting an ordinary coding session
showed **5 of 16 decisions were asks, every one uncertainty-driven with no risk
behind it.** Both causes are now settled *provably* rather than by moving a
threshold:

- `removesTests` — a file that holds no tests cannot have tests removed from it,
  so doubt about it on a non-test path is an unanswerable question, not an
  unresolved risk.
- `destroysContent` — only ever contributes conjoined with `escapesProject`
  (deny) or `emptiesFile` (ask). When both partners are confidently false the
  conjunction cannot fire whatever its value is, so its doubt cannot change the
  verdict — and an answer that cannot change the verdict must not manufacture a
  prompt.

```
asks in an ordinary coding session:   5  ->  3  ->  0
guard live suite:                     62/62, all 14 denies intact
```

The entire permission-fatigue cost on routine work, removed with no safety
traded.

## Finding 4: a new capability, mechanism-proven and outcome-unproven

Sonnet's one reproducible failure mode is **exhaustiveness under tedium**. On a
19-call-site rename it repeatedly produced 17/19 with the suite green, and then
reported *"every call site passes its top-level folder"* — a confident false
universal claim. Two sites imported the symbol under a local alias, so a grep
for the direct name returned 17 and looked complete.

`done` did not catch it: the tests genuinely passed, so the claim-to-command
join had nothing to fire on.

So `verifySweepClaims` was built, in the same shape as the join that already
works:

- **Jev judges** one field: does the message claim a change reached *every*
  place it belongs?
- **Code verifies** the transcript: did a codebase-wide search run *after* the
  last edit?

Replayed against the real transcripts:

| run | truth | gate |
| --- | --- | --- |
| rep1 | 17/19, incomplete | **block** ✓ |
| rep5 | 17/19, incomplete | **block** ✓ |
| rep3 | 19/19, searched for both the symbol and its alias | allow ✓ |
| rep2 | complete | block ✗ |
| rep4 | complete | block ✗ |

Every failing run had verified its own edits — tests, typecheck, `git diff` —
and never once searched for what it had missed. The run that found all 19
searched for both `audit(` and `trace(`.

**It ships off by default, and the measurement is why.** On a live task sonnet
handles correctly it fired in 6 of 8 runs and added 35% wall-clock to catch
nothing. Enable it for large mechanical refactors, where a silently missed call
site is expensive and one verification turn is not:

```jsonc
{ "done": { "verifySweepClaims": true } }
```

## A measurement error worth recording

An earlier draft of this document claimed the sweep gate produced +28 points on
`hard-audit-area`. It did not. The task file was modified at 16:30 while its
calibration runs had executed at 15:47 and 16:07 — the difficulty was still
being escalated. The jev arm ran against the final version and the baseline
figure came from an earlier one, so the comparison was between two different
tasks. Re-run against the same version, baseline is 8/8 and jev 7/8.

File mtimes are part of the experiment. This is the third measurement artefact
this benchmark has produced, after the turn cap and the invisible hook
decisions, and all three initially looked like real effects.

## Conclusion

On sonnet, jev's value is not in pass rates — there is no headroom to take. It
is in removing its own cost (permission fatigue and false blocks, both now
fixed) and in the opt-in gate for the one failure mode that does reproduce.

The honest recommendation is unchanged from `FINDINGS.md`: run jev on weaker or
cheaper models, where it is worth a clear double-digit improvement. On a
frontier model, run `guard` and `screen` for defence in depth, and turn on
`verifySweepClaims` when the task is a large mechanical sweep.
