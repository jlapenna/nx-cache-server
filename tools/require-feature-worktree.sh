#!/usr/bin/env bash
set -euo pipefail

git_dir="$(git rev-parse --path-format=absolute --git-dir)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
branch="$(git symbolic-ref --quiet --short HEAD || printf '<detached HEAD>')"

if [ "$git_dir" != "$common_dir" ] && [ "$branch" != "main" ]; then
  exit 0
fi

echo "ERROR: commits and pushes must come from a feature worktree." >&2
echo "Create a linked worktree and submit a pull request." >&2
exit 1
