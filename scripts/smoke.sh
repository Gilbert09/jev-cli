#!/usr/bin/env bash
# End-to-end smoke test: pipe realistic hook payloads through the BUILT binary
# and assert the contract holds. Runs without an API key, in which case it
# verifies the failure behaviour instead — which is the part that matters most.
set -uo pipefail
cd "$(dirname "$0")/.."

JEV="node bin/jev.mjs"
pass=0; fail=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    printf '  ok    %s\n' "$name"; pass=$((pass+1))
  else
    printf '  FAIL  %s\n         expected to contain: %s\n         got: %s\n' "$name" "$expected" "$actual"
    fail=$((fail+1))
  fi
}

printf '\nhook contract\n'

out=$(echo '{"session_id":"s","cwd":"/r","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' | $JEV guard)
check "guard emits a PreToolUse decision" '"hookEventName":"PreToolUse"' "$out"
check "guard emits valid JSON" '"permissionDecision"' "$out"

out=$(echo '' | $JEV guard)
check "guard fails CLOSED on empty stdin" '"permissionDecision":"ask"' "$out"

out=$(echo '{bad json' | $JEV guard)
check "guard fails CLOSED on malformed stdin" '"permissionDecision":"ask"' "$out"

out=$(echo '{"session_id":"s","cwd":"/r","hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/r/a.md"},"tool_output":"hi"}' | $JEV screen)
check "screen fails OPEN (emits nothing)" "" "$out"
[[ -z "$out" ]] && { printf '  ok    screen stays silent when it cannot judge\n'; pass=$((pass+1)); } \
                || { printf '  FAIL  screen should emit nothing, got: %s\n' "$out"; fail=$((fail+1)); }

out=$(echo '{"session_id":"s","cwd":"/r","hook_event_name":"Stop","last_assistant_message":"done"}' | $JEV done)
[[ -z "$out" ]] && { printf '  ok    done fails OPEN (allows the stop)\n'; pass=$((pass+1)); } \
                || { printf '  FAIL  done should emit nothing, got: %s\n' "$out"; fail=$((fail+1)); }

printf '\nwire contract (verified against the hook reference)\n'

# A Stop block is top-level {"decision":"block","reason":...} — NOT nested in
# hookSpecificOutput, and "block" is the only value `decision` accepts. An
# earlier version emitted hookSpecificOutput.decision="continue", which Claude
# Code silently ignores: every intervention was a no-op and nothing caught it.
cat > /tmp/jev-smoke-transcript.jsonl <<'JSONL'
{"type":"user","message":{"role":"user","content":"Add a slugify helper with tests."}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/text.ts"}}]}}
JSONL
if [[ -n "${TYPESAFE_API_KEY:-}" ]]; then
  out=$(printf '{"session_id":"smoke-%s","cwd":"/r","hook_event_name":"Stop","prompt_id":"p%s","last_assistant_message":"Added slugify. All tests pass, the suite is green.","transcript_path":"/tmp/jev-smoke-transcript.jsonl"}' "$RANDOM" "$RANDOM" | $JEV done)
  check "Stop block uses top-level decision=block" '"decision":"block"' "$out"
  check "Stop block carries the required reason" '"reason"' "$out"
  if [[ "$out" == *"hookSpecificOutput"* ]]; then
    printf '  FAIL  Stop must NOT nest decision in hookSpecificOutput\n'; fail=$((fail+1))
  else
    printf '  ok    Stop does not nest decision in hookSpecificOutput\n'; pass=$((pass+1))
  fi
else
  printf '  skip  Stop wire contract (needs TYPESAFE_API_KEY)\n'
fi

printf '\nprocess behaviour\n'

# Every hook must exit 0. A non-zero exit is reported to the user as a hook
# error even when the JSON is valid.
echo '{"session_id":"s","cwd":"/r","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' | $JEV guard >/dev/null 2>&1
check "guard exits 0" "0" "$?"

start=$(date +%s%N)
echo '{"session_id":"s","cwd":"/r","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' | $JEV guard >/dev/null 2>&1
elapsed=$(( ($(date +%s%N) - start) / 1000000 ))
printf '  info  guard round trip: %sms\n' "$elapsed"
if (( elapsed < 3500 )); then
  printf '  ok    guard stays inside its budget\n'; pass=$((pass+1))
else
  printf '  FAIL  guard took %sms, over budget\n' "$elapsed"; fail=$((fail+1))
fi

out=$($JEV nonsense 2>&1)
check "unknown subcommand is reported" "unknown subcommand" "$out"

printf '\n%s passed, %s failed\n\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
