#!/usr/bin/env bash
# Protect the Agent LCARS Work API boundary in this consumer repository.
# Every provider caller must accept either a GitHub issue anchor or a native
# work-item anchor and preserve that union through its fallback finalizer.
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0
for provider in claude codex opencode; do
  workflow=".github/workflows/$provider.yml"
  case "$provider" in
    claude) agent=Claude ;;
    codex) agent=Codex ;;
    opencode) agent=OpenCode ;;
  esac

  grep -Pzo "issue:\n\s+description:[^\n]*\n\s+required: false\n\s+default: ''" "$workflow" >/dev/null || {
    echo "$workflow: issue input must be optional with an empty default"
    fail=1
  }

  expected="run-name: \"\${{ inputs.issue != '' && format('#{0}', inputs.issue) || 'native work' }}: ${agent} issue agent [dispatch:g\${{ inputs.broker_generation }}:\${{ inputs.broker_intent_id }}]\""
  grep -Fqx "$expected" "$workflow" || {
    echo "$workflow: run-name must identify issue and native-work dispatches"
    fail=1
  }

  gate_count=$(grep -Fc "inputs.issue != '' || inputs.work != ''" "$workflow" || true)
  if [ "$gate_count" -lt 2 ]; then
    echo "$workflow: worker and fallback gates must accept either anchor"
    fail=1
  fi

  awk '
    /^  fallback-finalize:$/ { in_finalizer = 1 }
    in_finalizer && /^      work: \$\{\{ inputs\.work \}\}$/ { forwards_work = 1 }
    END { exit forwards_work ? 0 : 1 }
  ' "$workflow" || {
    echo "$workflow: fallback finalizer must receive the work payload"
    fail=1
  }
done

exit "$fail"
