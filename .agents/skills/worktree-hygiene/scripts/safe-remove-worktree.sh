#!/bin/bash
# Safety-checked git worktree removal.
#
# Refuses to remove a worktree that either (a) has a live process with cwd
# inside it, or (b) has uncommitted changes — both are common signs of a
# still-in-use or crashed-but-unmerged session, not garbage. Override only
# after you've personally reviewed what it would refuse to remove.
#
# Usage: safe-remove-worktree.sh <worktree-path> [--git-dir <owner>] [--force-anyway] [--dry-run]
set -euo pipefail
WT="${1:?usage: safe-remove-worktree.sh <worktree-path> [--force-anyway] [--dry-run]}"
shift
FORCE_ANYWAY=false
DRY_RUN=false
OWNER=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force-anyway) FORCE_ANYWAY=true ;;
    --dry-run) DRY_RUN=true ;;
    --git-dir)
      [ "$#" -ge 2 ] || {
        echo "--git-dir requires an owning checkout or Git directory" >&2
        exit 64
      }
      OWNER="$2"
      shift
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 64
      ;;
  esac
  shift
done

if [ ! -d "$WT" ]; then
  echo "no such directory: $WT" >&2
  exit 1
fi
WT_ABS=$(cd "$WT" && pwd -P)

# `git worktree remove` is repository-scoped. Resolve the target's owning
# common directory even when a partial removal already deleted its `.git`
# link. For the missing-link case, inspect ancestor and sibling repositories'
# authoritative worktree records for this exact path.
GIT_DIR=""
GIT_COMMON_DIR=""
if [ -n "$OWNER" ]; then
  if git -C "$OWNER" rev-parse --git-dir >/dev/null 2>&1; then
    GIT_COMMON_DIR=$(git -C "$OWNER" rev-parse --path-format=absolute --git-common-dir)
  elif git --git-dir="$OWNER" rev-parse --git-dir >/dev/null 2>&1; then
    GIT_COMMON_DIR=$(git --git-dir="$OWNER" rev-parse --path-format=absolute --git-common-dir)
  else
    echo "REFUSING: --git-dir does not identify an owning checkout or Git directory: $OWNER" >&2
    exit 4
  fi
  if [ -e "$WT_ABS/.git" ] &&
    git -C "$WT_ABS" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    target_common_dir=$(git -C "$WT_ABS" rev-parse --path-format=absolute --git-common-dir)
    if [ "$target_common_dir" != "$GIT_COMMON_DIR" ]; then
      echo "REFUSING: $WT_ABS is not owned by --git-dir $OWNER." >&2
      exit 4
    fi
    GIT_DIR=$(git -C "$WT_ABS" rev-parse --path-format=absolute --git-dir)
  else
    GIT_DIR="$GIT_COMMON_DIR"
  fi
  owner_records=$(git --git-dir="$GIT_COMMON_DIR" worktree list --porcelain 2>/dev/null || true)
  if ! printf '%s\n' "$owner_records" | grep -Fqx "worktree $WT_ABS"; then
    echo "REFUSING: $WT_ABS is not registered to --git-dir $OWNER." >&2
    exit 4
  fi
elif git -C "$WT_ABS" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_DIR=$(git -C "$WT_ABS" rev-parse --path-format=absolute --git-dir)
  GIT_COMMON_DIR=$(git -C "$WT_ABS" rev-parse --path-format=absolute --git-common-dir)
else
  search_parent=$(dirname "$WT_ABS")
  candidates=()
  ancestor="$search_parent"
  while [ "$ancestor" != "/" ]; do
    [ -d "$ancestor/.git" ] && candidates+=("$ancestor/.git")
    ancestor=$(dirname "$ancestor")
  done
  for candidate in "$search_parent"/*/.git; do
    [ -d "$candidate" ] && candidates+=("$candidate")
  done
  for candidate in "${candidates[@]}"; do
    records=$(git --git-dir="$candidate" worktree list --porcelain 2>/dev/null || true)
    if printf '%s\n' "$records" | grep -Fqx "worktree $WT_ABS"; then
      GIT_COMMON_DIR=$(cd "$candidate" && pwd)
      GIT_DIR="$GIT_COMMON_DIR"
      break
    fi
  done
  if [ -z "$GIT_COMMON_DIR" ]; then
    echo "REFUSING: $WT_ABS is not a registered Git worktree." >&2
    exit 4
  fi
fi
WORKTREE_RECORDS=$(git --git-dir="$GIT_COMMON_DIR" worktree list --porcelain)
PRIMARY_WORKTREE=$(printf '%s\n' "$WORKTREE_RECORDS" | sed -n 's/^worktree //p' | head -n 1)
if [ "$WT_ABS" = "$PRIMARY_WORKTREE" ]; then
  echo "REFUSING: $WT_ABS is the primary checkout, not a linked worktree." >&2
  exit 4
fi

# A partially failed `git worktree remove` deletes the linked worktree's
# `.git` file before failing to remove its directory. From that point,
# `git -C "$WT_ABS"` walks up to the primary checkout and reports its common
# directory as both GIT_DIR and GIT_COMMON_DIR. Do not mistake that orphan for
# the primary checkout; confirm that Git still has a linked-worktree record.
if [ "$GIT_DIR" = "$GIT_COMMON_DIR" ]; then
  if ! printf '%s\n' "$WORKTREE_RECORDS" | grep -Fqx "worktree $WT_ABS"; then
    echo "REFUSING: $WT_ABS is not a registered linked worktree." >&2
    exit 4
  fi

  echo "== partially removed linked worktree: $WT_ABS ==" >&2
  echo "Its .git link is missing, so Git cannot safely report its status." >&2
  echo "== live processes with cwd under $WT_ABS =="
  hits=0
  for pid_dir in /proc/[0-9]*; do
    pid="${pid_dir#/proc/}"
    link=$(readlink "$pid_dir/cwd" 2>/dev/null) || continue
    case "$link" in
      "$WT_ABS" | "$WT_ABS"/*) ;;
      *) continue ;;
    esac
    cmd=$(tr '\0' ' ' < "$pid_dir/cmdline" 2>/dev/null || echo "?")
    echo "  $pid  $link  $cmd"
    hits=$((hits + 1))
  done
  if [ "$hits" -gt 0 ] && [ "$FORCE_ANYWAY" != true ]; then
    echo "REFUSING: $hits live process(es) found under this worktree." >&2
    exit 2
  fi
  if [ "$FORCE_ANYWAY" != true ]; then
    echo "REFUSING: inspect this orphaned directory, then re-run with --force-anyway to repair its Git link and remove it." >&2
    exit 4
  fi

  WORKTREE_ADMIN_DIR=""
  for admin_dir in "$GIT_COMMON_DIR"/worktrees/*; do
    [ -d "$admin_dir" ] && [ ! -L "$admin_dir" ] && [ -f "$admin_dir/gitdir" ] || continue
    admin_git_link=$(sed -n '1p' "$admin_dir/gitdir")
    [ "$(basename "$admin_git_link")" = ".git" ] || continue
    admin_worktree=$(dirname "$admin_git_link")
    [ -d "$admin_worktree" ] || continue
    admin_worktree=$(cd "$admin_worktree" && pwd -P)
    [ "$admin_worktree" = "$WT_ABS" ] || continue
    if [ -n "$WORKTREE_ADMIN_DIR" ]; then
      echo "REFUSING: multiple Git administrative records point to $WT_ABS." >&2
      exit 4
    fi
    WORKTREE_ADMIN_DIR=$(cd "$admin_dir" && pwd -P)
  done
  if [ -z "$WORKTREE_ADMIN_DIR" ]; then
    echo "REFUSING: could not identify the exact Git administrative record for $WT_ABS." >&2
    exit 4
  fi

  echo "== recovering partially removed worktree $WT_ABS =="
  if [ -e "$WT_ABS/.git" ] || [ -L "$WT_ABS/.git" ]; then
    echo "REFUSING: $WT_ABS/.git appeared during recovery; it will not be overwritten." >&2
    exit 4
  fi
  if [ "$DRY_RUN" = true ]; then
    echo "DRY RUN: restore $WT_ABS/.git -> $WORKTREE_ADMIN_DIR"
    echo "DRY RUN: git --git-dir=\"$GIT_COMMON_DIR\" worktree remove \"$WT_ABS\" --force"
    exit 0
  fi
  if ! (set -o noclobber; printf 'gitdir: %s\n' "$WORKTREE_ADMIN_DIR" >"$WT_ABS/.git"); then
    echo "REFUSING: could not create $WT_ABS/.git exclusively; nothing was overwritten." >&2
    exit 4
  fi
  if ! git --git-dir="$GIT_COMMON_DIR" worktree remove "$WT_ABS" --force; then
    echo "ERROR: exact worktree removal failed after restoring $WT_ABS/.git." >&2
    echo "The Git link is repaired; inspect the worktree and rerun normal removal." >&2
    exit 5
  fi
  echo "done."
  exit 0
fi

echo "== owning Git directory: $GIT_COMMON_DIR =="

echo "== live processes with cwd under $WT_ABS =="
hits=0
for pid_dir in /proc/[0-9]*; do
  pid="${pid_dir#/proc/}"
  link=$(readlink "$pid_dir/cwd" 2>/dev/null) || continue
  case "$link" in
    "$WT_ABS" | "$WT_ABS"/*) ;;
    *) continue ;;
  esac
  cmd=$(tr '\0' ' ' < "$pid_dir/cmdline" 2>/dev/null || echo "?")
  echo "  $pid  $link  $cmd"
  hits=$((hits + 1))
done
if [ "$hits" -gt 0 ] && [ "$FORCE_ANYWAY" != true ]; then
  echo "REFUSING: $hits live process(es) found under this worktree." >&2
  echo "If these are confirmed dead/unrelated, re-run with --force-anyway." >&2
  exit 2
fi

echo "== git status in worktree =="
git -C "$WT_ABS" status --porcelain || true
dirty=$(git -C "$WT_ABS" status --porcelain 2>/dev/null | wc -l)
if [ "$dirty" -gt 0 ] && [ "$FORCE_ANYWAY" != true ]; then
  echo "REFUSING: worktree has $dirty uncommitted change(s)." >&2
  echo "This may be un-pushed WIP from a crashed session, not garbage." >&2
  echo "Review with: git -C \"$WT_ABS\" diff" >&2
  echo "Then re-run with --force-anyway if it's truly disposable." >&2
  exit 3
fi

echo "== removing $WT_ABS =="
if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN: git --git-dir=\"$GIT_COMMON_DIR\" worktree remove \"$WT_ABS\" --force"
  exit 0
fi
if ! git --git-dir="$GIT_COMMON_DIR" worktree remove "$WT_ABS" --force; then
  echo "ERROR: Git could not remove $WT_ABS." >&2
  if [ ! -e "$WT_ABS/.git" ]; then
    echo "Its .git link is now missing; after inspecting the remaining directory, rerun with --force-anyway to recover it." >&2
  fi
  exit 5
fi
if [ -e "$WT_ABS" ]; then
  echo "ERROR: Git removed the worktree registration but left $WT_ABS on disk." >&2
  echo "After inspecting it, rerun with --force-anyway to remove the orphaned directory." >&2
  exit 5
fi
echo "done."
echo "If that reported a locked working tree from a pid you've confirmed is dead,"
echo "re-run: git --git-dir=\"$GIT_COMMON_DIR\" worktree remove \"$WT_ABS\" --force --force"
