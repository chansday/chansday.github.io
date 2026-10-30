#!/usr/bin/env bash
# Commits the already staged changes as github-actions[bot] and pushes them to
# the workflow's branch, rebasing onto concurrent pushes (3 attempts).
# Usage: bash scripts/commit-and-push.sh "<commit message>"
set -euo pipefail
message="${1:?commit message required}"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git commit -m "$message"
branch="${GITHUB_REF_NAME:-main}"
for i in 1 2 3; do
  if git pull --rebase --autostash origin "$branch" && git push origin "HEAD:$branch"; then exit 0; fi
  git rebase --abort >/dev/null 2>&1 || true
  sleep $((i * 5))
done
echo "::error::git push failed after 3 attempts"
exit 1
