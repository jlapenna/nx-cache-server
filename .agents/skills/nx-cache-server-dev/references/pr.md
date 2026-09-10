# Pull Request Lifecycle

Create a ready PR with the change, rationale, security impact where relevant,
and exact verification. Confirm the pushed SHA matches the PR head and that the
required `verify` check was created.

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

Squash-merge through protection when `verify` passes and all actionable threads
are resolved. Confirm `gh pr view --json state,mergedAt,mergeCommit` reports an
actual merge. Do not deploy; Homelab owns rollout.

Finally, follow the shared `worktree-hygiene` skill. From outside the target,
use its evidence-backed cleanup command:

```bash
repo-sweep-worktrees --repo <primary-path> --path <worktree-path> --base origin/main
repo-sweep-worktrees --repo <primary-path> --path <worktree-path> --base origin/main --delete
```

The command checks PR ownership, merge evidence, cleanliness, and live processes
before removing the worktree and compare-and-deleting its local branch. KEEP
means retain and investigate, not force removal. Standalone remote branches use
`repo-audit-branches`; refresh and fast-forward primary `main` only when clean
and already on that branch. Never switch another session's checkout.
