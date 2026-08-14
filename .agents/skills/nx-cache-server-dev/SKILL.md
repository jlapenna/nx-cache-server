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

The active `Protect main` ruleset is managed by Homelab Terraform. It requires
the `Verify` check, resolved review threads, linear history, and disallows
force-pushes or protected-branch deletion.
