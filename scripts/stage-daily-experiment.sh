#!/usr/bin/env bash
set -euo pipefail
[[ "${EXPERIMENT_DATE:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]
if [ "${EXPERIMENT_CANDIDATE:-false}" = true ]; then
  [[ "${EXPERIMENT_CANDIDATES:-}" =~ ^(before-open|during-market)(,(before-open|during-market))?$ ]]
  IFS=',' read -ra phases <<< "$EXPERIMENT_CANDIDATES"
  for phase in "${phases[@]}"; do
    node scripts/stage-daily-experiment.mjs "$EXPERIMENT_DATE" "$phase"
  done
fi
if [ "${STATUS_SAVED:-false}" = true ]; then
  node scripts/stage-experiment-status.mjs "$EXPERIMENT_DATE" "${STATUS_HASH:-}"
fi
