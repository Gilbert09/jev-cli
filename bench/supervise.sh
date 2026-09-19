#!/usr/bin/env bash
#
# Run the benchmark across as many quota windows as it takes.
#
# 3,040 sessions do not fit in one 5-hour API window. The runner exits 75 when
# the window is spent and prints RESETS_AT=<unix seconds>; this waits for that
# moment and resumes. The runner is resumable by runId, so nothing is repeated
# and nothing is lost if this is interrupted.
#
# Usage:  ./bench/supervise.sh
# Env:    BENCH_* as for run.mjs, plus SUPERVISE_MAX_WINDOWS (default 12)
set -uo pipefail
cd "$(dirname "$0")/.."

: "${BENCH_OUT:=scaled.jsonl}"
: "${SUPERVISE_MAX_WINDOWS:=12}"
LOG=bench/results/supervise.log
RESULTS="bench/results/${BENCH_OUT}"

say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$1" | tee -a "$LOG"; }

say "supervisor starting; results -> $RESULTS"

for window in $(seq 1 "$SUPERVISE_MAX_WINDOWS"); do
  before=$(wc -l < "$RESULTS" 2>/dev/null | tr -d ' ' || echo 0)
  say "window $window: starting (banked: ${before:-0} runs)"

  out=$(node bench/run.mjs 2>&1)
  code=$?
  printf '%s\n' "$out" >> "$LOG"

  after=$(wc -l < "$RESULTS" 2>/dev/null | tr -d ' ' || echo 0)
  say "window $window: exit=$code, ${before:-0} -> ${after:-0} runs"

  if [[ $code -eq 0 ]]; then
    # Nothing left in the plan, or the budget cap stopped us. Either way, done.
    say "run.mjs exited 0 — benchmark complete or budget reached"
    break
  fi

  if [[ $code -ne 75 ]]; then
    say "unexpected exit $code — stopping rather than looping on a real error"
    break
  fi

  # Window spent. Wait for the reset the API told us about, plus a small buffer
  # so we are not the first request through the door.
  resets=$(printf '%s\n' "$out" | grep -o 'RESETS_AT=[0-9]*' | tail -1 | cut -d= -f2)
  now=$(date +%s)
  if [[ -n "${resets:-}" && "$resets" -gt "$now" ]]; then
    wait=$(( resets - now + 120 ))
  else
    wait=1800   # no reset time reported; back off half an hour and retry
  fi
  say "quota window spent; sleeping $(( wait / 60 ))m until reset"
  sleep "$wait"
done

say "supervisor finished: $(wc -l < "$RESULTS" 2>/dev/null | tr -d ' ') runs banked"
