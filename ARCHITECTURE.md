# Architecture

This document maps the service's boundaries and ownership. `README.md`
explains how to use the service; this document explains where a change belongs
and what proves it.

## System Flow

```text
Nx client
  |  Bearer token + native cache request
  v
apps/nx-cache-server/server.js
  |-- authenticate against scalar credentials or a token map
  |-- validate GET/HEAD/PUT /v1/cache/<hash>
  |-- stream uploads to temporary files
  |-- publish immutable entries with no-replace hard links
  |-- prune by age and size
  |-- expose /healthz and /metrics
  v
filesystem cache directory
```

The server deliberately has no runtime package dependencies. Node's standard
library owns HTTP, streaming, filesystem, and cryptographic operations.

## Ownership Map

| Concern | Source of truth | Evidence |
| --- | --- | --- |
| HTTP and cache semantics | `apps/nx-cache-server/server.js` | `apps/nx-cache-server/server.test.js` |
| Runtime configuration | environment parsing in `server.js` | startup and protocol tests |
| Local container shape | `apps/nx-cache-server/Dockerfile`, `docker-compose.yml` | container build and ownership check |
| Nx task graph | `apps/nx-cache-server/project.json`, `package.json` | `npm run verify` |
| Contributor workflow | `.agents/skills/nx-cache-server-dev/`, `CONTRIBUTING.md` | hooks and protected PR checks |
| Production desired state | Homelab repository | Homelab validation and reconciliation |
| GitHub protection | `infra/github-ruleset/` | repository validation and protected merge |

## Security Boundaries

- Every cache read or write requires a bearer credential; liveness and metrics
  are intentionally unauthenticated.
- Token-map values and scalar tokens are runtime inputs. They must never enter
  source control, logs, metrics labels, or command output.
- Read-only credentials may fetch entries but cannot publish them.
- Cache keys select entries, but never arbitrary filesystem paths.
- Uploads become visible only after complete publication; existing entries are
  immutable.

Changes in any of these areas require focused regression coverage in addition
to the full repository gate.

## Deployment Boundary

This repository produces reviewed source and a buildable image. It does not
publish a public image or deploy production. Homelab owns the internal image
publisher, deployed digest, secret delivery, service configuration, canary,
and rollback. If production desired state changes, make that change in
Homelab and use its approval and verification path.

Nothing in this repository notifies Homelab, and source changes do not
reach production immediately: Homelab and Agent LCARS are separate systems,
so no workflow here uses the Agent LCARS App to dispatch Homelab. Homelab
delivers `main` on its own daily backstop, when it applies new configuration,
or when the maintainer runs
`gh workflow run source-reconcile.yml -R jlapenna/homelab -f source=nx-cache-server`.

## Proof Ladder

Use the cheapest useful evidence while iterating, then run the complete gate:

1. syntax or focused Node tests for the changed behavior;
2. `npm run verify` for lint and protocol regressions;
3. `docker compose config -q` for the local runtime contract;
4. the container build and ownership assertion when container shape changes;
5. protected CI on the exact pull-request head.

Production health is separate evidence and remains a Homelab concern.
