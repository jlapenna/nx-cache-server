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

Cleanup of your own task checkout is mandatory whenever the task ends,
including failed, blocked, and unmerged work. Follow the **current shared
[worktree-hygiene skill](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/worktree-hygiene/SKILL.md)**
for tool provenance, cleanup commands, authorized recovery and real safety
refusals. Standalone branch cleanup follows the current `stale-branch-cleanup`
skill at `~/.agents/skills/stale-branch-cleanup/SKILL.md`. Keep those mechanics
in their shared owners rather than copying them here.

Stop your own watchers, servers, and failed workers. Move outside the target;
**set an outside `workdir` on every cleanup exec-tool call**. A previous shell's
`cd` does not persist. Fix an own caller or parent cwd instead of leaving the
checkout behind; preserve genuine foreign-process and other safety guards.
Preserve unmerged work through its authorized recovery route and never label
it merged.

Verify both filesystem-path and Git-registration absence, and record the
branch outcome under the shared procedure. If a real guard retains a checkout,
report its exact path and reason instead of claiming successful cleanup.
Fast-forward the verified clean primary already on `main` until it equals
`origin/main`; preserve unrelated work and never switch another session's
checkout. A primary synchronization blocker is separate from own checkout
removal.
