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
# Load the authoritative public worktree-hygiene skill for Codex. This is a
# thin, idempotent loader and deliberately does not copy the skill body.
if command -v codex >/dev/null 2>&1; then
  codex plugin marketplace add jlapenna/repo-tools --ref main >/dev/null
  codex plugin marketplace upgrade repo-tools >/dev/null
  codex plugin add repo-tools@repo-tools >/dev/null
fi
echo "Worktree ready."
