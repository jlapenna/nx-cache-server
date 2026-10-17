# Pull Request Lifecycle

Create a ready PR with the change, rationale, security impact where relevant,
and exact verification. Confirm the pushed SHA matches the PR head and that the
required `verify`, `validate / repository validation`, and
`repository-owned Terraform` checks were created.

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

Squash-merge through protection when all required checks pass and all
actionable threads are resolved. Confirm
`gh pr view --json state,mergedAt,mergeCommit` reports an actual merge. Do not
deploy; Homelab owns rollout.

## Task-end cleanup

Cleanup of your own task checkout is mandatory when the task ends, including
failed, blocked, and unmerged work. The shared `worktree-hygiene` skill owns the
procedure and real safety guards; use the appropriate authorized route below.

1. Retain the absolute primary and target paths, exact branch and HEAD, and any
   recovery references. Stop your own watchers, servers, and failed workers.
   Move outside the target before cleanup. **For exec tools, set an outside
   `workdir` on every call**; a previous shell's `cd` does not persist. Shell
   examples independently change directory too. An own caller or parent cwd is
   a condition to fix, not a reason to abandon cleanup; genuine foreign
   processes, locks, configuration, operation, and resource guards remain KEEP.
2. Select the current managed CLI at `$HOME/.local/bin`, outside the target.
   Verify its actual shim target and helper bytes against a reviewed release
   containing repo-tools PR #149's caller-aware safety fixes (v2.0.10 or a
   verified successor). PATH lookup, a shared skill link, or the package's
   internal version alone does not prove provenance. If that managed tool is
   unavailable or unverifiable, retain the target with that exact blocker;
   do not silently choose a repo-local dependency.
3. For a merged task, run the shared evidence-backed audit and then apply it:

   ```bash
   (cd / && "$HOME/.local/bin/repo-prune-merged-worktrees" --repo <absolute-primary-path> --base origin/main --fetch <absolute-worktree-path>)
   (cd / && "$HOME/.local/bin/repo-prune-merged-worktrees" --repo <absolute-primary-path> --base origin/main --fetch --delete <absolute-worktree-path>)
   ```

   Keep any repository-documented consumer resource adapter in both calls.
   Investigate the precise KEEP reason; never force past it or kill another
   session. The audit and apply must bind the same target and exact task head.
4. Failed, blocked, or unmerged work is not merged cleanup. Use the current
   shared, explicitly authorized own-task recovery/parking workflow, preserving
   exact history, raw index, staged objects, private working files and their
   absences before removal. Preserve its branch and protected recovery refs;
   do not delete them as though merged. Respect dirty, live, locked, nested,
   unsupported-index, and other real refusals. A standing creation-age grant
   uses reliable Git-link birth time, not commit age or a weakened inactivity
   window; it does not waive guards or automatically cover a young checkout.
5. Verify both the actual filesystem path and its Git worktree registration
   are absent. Record the intended local and named remote branch outcome;
   use the qualified managed `repo-audit-branches` for a merged task's named
   remote audit, never a broad deletion. Keep private recovery receipts and
   remove only your own disposable worker/cache scratch. Fast-forward a clean
   primary already on `main` and verify it equals `origin/main`; preserve any
   unrelated work. A primary synchronization blocker is separate from own
   checkout removal. If a real guard retains the checkout, report its exact
   path and reason rather than claiming cleanup succeeded.
