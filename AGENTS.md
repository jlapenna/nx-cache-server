# Nx Cache Server Agent Guide

This file is a router, not a procedure manual. Load only the context needed
for the task.

## Start Here

- Read `.agents/skills/nx-cache-server-dev/SKILL.md` before any edit, Git
  mutation, verification, or pull-request work. Its references own the
  workflow details.
- Read `ARCHITECTURE.md` before changing runtime behavior, authentication,
  storage, observability, containers, or the Homelab boundary.
- Use `docs/README.md` to find the durable documentation for the task.
- Keep the primary checkout on clean `main`; the development skill defines
  the linked-worktree workflow.

## Task Routes

| Task | Read first | Proof |
| --- | --- | --- |
| Server or cache protocol | `ARCHITECTURE.md`, `apps/nx-cache-server/server.test.js` | `npm run verify` |
| Credentials or authorization | `SECURITY.md`, `ARCHITECTURE.md` | focused protocol tests, then `npm run verify` |
| Container or runtime user | `apps/nx-cache-server/Dockerfile`, development skill verification reference | full gate plus container ownership check |
| Local operation | `README.md`, `docker-compose.yml` | `docker compose config -q` |
| Production rollout | Homelab documentation | no deployment from this repository |
| Contribution or PR | `CONTRIBUTING.md`, development skill PR reference | protected PR lifecycle |

## Source-of-Truth Boundaries

- `apps/nx-cache-server/server.js` owns server behavior.
- `apps/nx-cache-server/server.test.js` owns protocol regression coverage.
- `apps/nx-cache-server/project.json` and `package.json` own runnable checks.
- `docker-compose.yml` is the local deployment example.
- Homelab owns production image publication, secrets, configuration, and
  rollout. A merge here never authorizes a production change.
- Never commit credentials, token maps, cache entries, or runtime state.

If a durable rule changes, update its owning document or executable check;
do not grow this router with duplicated procedures.

## Agent fleet membership

This repository is a member of the Agent LCARS fleet (onboarded in
jlapenna/agent-lcars#1325). The fleet's own conventions live in that repo
and are deliberately not restated here. Headless dispatches read the exact
shared contract from the file exported as `$AGENT_PROTOCOL_PATH`; interactive
authors can consult Agent LCARS's `docs/` for dispatch, credential, and
published-workflow contracts. Do not copy the shared protocol into this repo.

The worktree rules above are this repo's own, and they apply to dispatched
agents too.

The authoritative worktree-safety guidance is the `worktree-hygiene` skill in
the public [`jlapenna/repo-tools`](https://github.com/jlapenna/repo-tools)
Codex plugin. Do not mirror its body locally; use its `repo-*` commands and
follow that source in other runtimes.
