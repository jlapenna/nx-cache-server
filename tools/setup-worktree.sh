#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
git_dir="$(git rev-parse --path-format=absolute --git-dir)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
if [ "$git_dir" = "$common_dir" ]; then
  echo "ERROR: run tools/setup-worktree.sh from a linked feature worktree." >&2
  exit 1
fi

HUSKY=0 npm ci
npx husky
test -x .husky/_/pre-commit
test -x .husky/_/pre-push
echo "Worktree ready."
