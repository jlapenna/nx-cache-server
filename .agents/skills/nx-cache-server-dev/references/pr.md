# Pull Request Lifecycle

Create a ready PR with the change, rationale, security impact where relevant,
and exact verification. Confirm the pushed SHA matches the PR head and that the
required `Verify` check was created.

Repeat until the current head is complete:

1. Inspect failed Actions logs, fix the cause, re-run local verification, and
   push normally.
2. Inspect review summaries and paginated GraphQL `reviewThreads`; flat comment
   lists do not expose resolution state.
3. Address clear actionable feedback, verify it, reply with evidence, and only
   then resolve its thread. Ask before accepting ambiguous, conflicting, or
   materially scope-expanding feedback.
4. Re-check CI and review after every push; evidence from an older head does
   not count.

Squash-merge through protection when `Verify` passes and all actionable threads
are resolved. Confirm `gh pr view --json state,mergedAt,mergeCommit` reports an
actual merge. Do not deploy; Homelab owns rollout.

Finally, follow the personal `worktree-hygiene` cleanup: prove squash-tree
equivalence, require a clean worktree, scan for live processes, dry-run the safe
removal helper, remove the worktree and exact merged branch, then fast-forward
the clean primary `main` and verify it equals `origin/main`.
