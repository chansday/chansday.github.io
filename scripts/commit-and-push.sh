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
  echo "[$(date -u +%FT%TZ)] 저장소 반영 시도 $i/3 · 브랜치 $branch"
  if git pull --rebase --autostash origin "$branch" && git push origin "HEAD:$branch"; then exit 0; fi
  echo "::warning::저장소 반영 $i/3 실패 · 변경 사항 동기화 후 재시도"
  git rebase --abort >/dev/null 2>&1 || true
  if (( i < 3 )); then echo "재시도까지 $((i * 5))초 대기"; sleep $((i * 5)); fi
done
echo "::error::git push failed after 3 attempts"
exit 1

