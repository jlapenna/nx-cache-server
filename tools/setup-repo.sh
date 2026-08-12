#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
git_dir="$(git rev-parse --path-format=absolute --git-dir)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
if [ "$git_dir" != "$common_dir" ]; then
  echo "ERROR: run tools/setup-repo.sh from the primary checkout; use tools/setup-worktree.sh for linked worktrees." >&2
  exit 1
fi
npm ci
npx husky
test -x .git/hooks/pre-commit
echo "Repository ready."
