#!/usr/bin/env bash
# Runs exactly what CI runs, failing on the first problem.
# pipefail matters: without it, piping a step into `tail` hides its exit status.
set -euo pipefail

run() {
  printf '=== %s ===\n' "$1"
  shift
  "$@"
}

run typecheck npm run typecheck
run lint      npm run lint
run test      npm test
run build     npm run build
run smoke     env DEMO_MODE=true TWILIO_DEMO=true CALENDAR_DEMO=true LLM_DEMO=true npm run smoke

printf '\nAll checks passed.\n'
