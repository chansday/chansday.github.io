#!/usr/bin/env bash
# Drop-in replacement for `git add "$@"`. On Windows + Docker Desktop bind
# mounts (the local act runner), a path that was just created or renamed
# inside the container can briefly be reported as a reparse point to the
# Linux container ("fatal: ... is beyond a symbolic link") before the
# metadata settles - this never happens on GitHub-hosted runners. Retry a
# few times instead of failing the whole stage on that transient flake.
set -euo pipefail

for attempt in 1 2 3 4 5; do
  if err=$(git add "$@" 2>&1); then
    exit 0
  fi
  if [[ "$err" != *"is beyond a symbolic link"* ]]; then
    echo "$err" >&2
    exit 1
  fi
  echo "git add hit a transient bind-mount symlink flake (attempt $attempt/5); retrying..." >&2
  sleep 1
done
echo "$err" >&2
exit 1
