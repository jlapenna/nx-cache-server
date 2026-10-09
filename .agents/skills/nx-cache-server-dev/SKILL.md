---
name: nx-cache-server-dev
description: Develop, verify, publish, and land changes in jlapenna/nx-cache-server. Load for every coding, configuration, documentation, CI, or pull-request task in this repository because it defines mandatory worktree safety, verification, branch protection, and ownership boundaries with Homelab.
---

# Nx Cache Server Development

Use a dedicated linked feature worktree for every mutation. The primary
checkout stays clean on `main`.

## Guardrails

- Start from fresh `origin/main`, then run `./tools/setup-worktree.sh` in the
  linked worktree. Never commit from the primary checkout or bypass hooks.
- Never commit `.env`, token maps, cache data, credentials, or generated
  runtime state.
- Homelab owns production image references and deployment. This repository
  builds and tests the server; merging here does not authorize deployment or
  edits in the Homelab checkout.
- Security-sensitive changes to authentication, cache publication, paths, or
  credentials require focused regression coverage and an explicit PR summary.
- Opening a PR authorizes the originating session to carry it through current-
  head CI, actionable review, protected squash merge, and safe cleanup. Never
  bypass protection or force-push.

## Workflow

1. Read [references/verify.md](references/verify.md) before declaring the
   change complete.
2. Iterate with focused Nx targets, then run the complete local gate.
3. Review status, `git diff --check`, and the full diff; commit with hooks.
4. Follow [references/pr.md](references/pr.md) through merge and cleanup.

The active `Protect main` ruleset is declared in this repository's
`infra/github-ruleset` root. Homelab supplies its trusted credentials,
isolated backend configuration, approved execution path, and scheduled drift
check. The ruleset requires `verify`, `validate / repository validation`, and
`repository-owned Terraform`, resolved review threads, linear history, and
disallows force-pushes or protected-branch deletion.

## Harness and documentation upkeep

Use the [shared harness-maintenance workflow](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/harness-maintenance/SKILL.md), adapted from
[Ryan Lopopolo's field guide](https://github.com/lopopolo/harness-engineering/tree/226c8d35fb6ea3ed55467753dba6dea2b5fd5778). Start with the observed missed
decision, corroborate the failure and repair its earliest authoritative owner.
Keep repository domain facts here and general maintenance procedures shared.

`server.js` and its tests own the GET/HEAD/PUT and authentication contract.
Immutable cache publication belongs in its atomic server operation; avoid
parallel prose or UI authorities. A health request does not prove a cache hit
or safe concurrent publication. Native `npm run verify` and compose validation
prove local source contracts; Homelab owns image references and live rollout.

Keep root context a task router and retrieve conditional procedures through
skill references. Preserve dated history separately from current contracts.
Validate links, frontmatter, formatting and source consistency; those checks
do not establish better agent outcomes. Compare fresh use under comparable
model, tools and authority before making an effectiveness claim.
