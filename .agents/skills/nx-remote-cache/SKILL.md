---
name: nx-remote-cache
description: Configure or repair Nx workspaces that should use the self-hosted Nx L2 remote cache (nx-cache.lan.jlapenna.net), including local credential resolution, GitHub Actions CI credentials, and worktree-safe read-through. Use when adding Nx remote caching to a repository, diagnosing slow or silently uncached Nx builds, rotating the cache credential, or ensuring worktrees and CI retain cache access.
---

# Nx Remote Cache

Use the self-hosted L2 cache at `http://nx-cache.lan.jlapenna.net:3123` for
sharing Nx task results between checkouts, hosts, and CI. Treat it purely as
an optimization: losing it must fall back to local computation, never break a
build.

## Inspect first

1. Read the repository's `AGENTS.md`, setup scripts, `tools/nx` (or the Nx
   wrapper), `.gitignore`, worktree setup, and CI workflows. Follow the
   repository's own conventions rather than blindly copying these names.
2. If Git work is required, use `repo-tools:worktree-hygiene` before every Git mutation.
   Work in an unoccupied feature worktree; never add a credential to a shared
   primary checkout by accident.
3. Confirm the server is reachable without a credential:

   ```bash
   curl -fsS --max-time 1 http://nx-cache.lan.jlapenna.net:3123/healthz
   ```

   When off the LAN/VPN, retain the wiring but make the wrapper skip loading
   it after a short probe. Nx can otherwise spend roughly 45 seconds timing
   out each remote-cache write.

4. Do not make multiple repositories share `NX_CACHE_DIRECTORY`. That is an
   L1 disk location, not a repository namespace; it makes independent repos
   fight over eviction. Let Nx keep L1 per primary checkout and use L2 for
   cross-repository sharing.

## Local checkout design

Implement all of the following, adapting filenames to the repository's
existing structure.

- Add a gitignored `.nx-remote-cache.env` containing only:

  ```bash
  NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://nx-cache.lan.jlapenna.net:3123
  NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=<token>
  ```

  Create it with `umask 077` / mode `0600`. Never commit it, print its
  contents, put it in `.env.local`, or pass its value on a command line.

- Add an idempotent setup command, preferably
  `tools/setup-nx-remote-cache.sh`. It must run from the primary checkout and
  refuse to write from a linked worktree. Support an explicit rotation path
  such as `--force`; an existing file must not make a rotated credential
  permanently invisible.

- Resolve credentials in this order:

  1. `NX_CACHE_TOKEN_SPARK` from the encrypted age store. Read the
     `secrets-cli` skill before accessing it and consume only
     `secrets-get NX_CACHE_TOKEN_SPARK` inside the setup process. A failed
     lookup supplies no candidate; never print it or fall back to the whole store.
  2. The repository's explicitly identified GCP project, from
     `nx-cache-access-token` (or its documented equivalent) using
     `gcloud ... --project=<explicit-project>`.

  Never inherit an ambient `gcloud` project. A candidate must authenticate
  before it wins: GET a guaranteed-absent cache hash with its bearer token.
  `404` means accepted; `403` means rejected and requires trying the next
  source. Treat an unreachable or otherwise inconclusive server as a
  best-effort runtime concern, not a reason to expose credentials.

- Teach the repository's Nx wrapper to respect CI-provided
  `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` first. Otherwise, load the local env
  file only after a fast `/healthz` probe. In a linked worktree, when there is
  no local file, use `git rev-parse --git-common-dir` to read through to the
  primary checkout's `.nx-remote-cache.env`.

- Do not copy `.nx-remote-cache.env` in `setup-worktree.sh`. One primary copy
  avoids stale-token drift and also covers worktrees created directly with
  `git worktree add`, which never run setup tooling.

## CI design

Use repository variables and GitHub secrets; do not use a local env file in
CI. Configure:

- `NX_CACHE_URL` as the server URL;
- `NX_CACHE_TOKEN` as the write token for trusted events;
- `NX_CACHE_TOKEN_READONLY` only where a separately justified read-only
  boundary exists; it is not the default for every pull request.

Wire those values before Nx commands run. A composite action is preferable
when several jobs need it. It must:

- give same-repository PRs the write token when their authors are trusted
  contributors with repository write access. PRs are commonly the main cache
  workload, and making every one read-only prevents them from warming L2;
- route fork PRs without LAN access to a GitHub-hosted runner or disable the
  remote cache for them, so an unreachable cache does not impose timeout costs
  and untrusted code receives no credential;
- fail open when configuration is absent. Never use an expression fallback
  that can expose the write token to a fork or another untrusted boundary.

Do the token selection in shell with explicit branches. Do **not** use the
GitHub expression idiom `condition && read_only || write`: an empty
read-only secret is falsy and would leak the write credential to a PR.

Existing agent workflows may already pass the two environment variables. Audit
the actual workflows; add CI wiring only where it is missing, and use the
same trust boundary everywhere.

### E2E boundaries

An E2E target must stay uncached (`cache: false`) so a green result always
represents a fresh test execution. Do not use `--skip-nx-cache`: that broad
switch also bypasses useful cached dependency artifacts. If an E2E wrapper
starts from `env -i`, pass only the complete `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` /
`NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` pair through the boundary, and only
when both are set. This allows deterministic nested build targets to use L2
without admitting broader CI credentials or replaying the test task itself.

## Verification

1. Run the repository's shell syntax, lint, YAML, formatting, and targeted
   test checks. Do not bypass hooks.
2. Prove local read-through: remove only a disposable worktree copy of the
   ignored file, invoke the wrapper preamble, and confirm the server variable
   and a set token are loaded from the primary. Do not display the token.
3. Authenticate a configured local credential with an absent-cache GET; `404`
   is success. This proves authentication, not write permission.
4. Trigger real CI from the exact branch. A trusted `workflow_dispatch` and a
   same-repository PR should both be able to warm the cache when configured.
   Check the cache-server logs around the run: `PUT` with `200` / `stored`
   proves writes. Verify that a fork PR skips cache setup entirely. Correlate
   by timestamp rather than assuming unrelated CI traffic belongs to the run.
5. Let required CI jobs finish before claiming success. The first run may be
   cold; a repeat of unchanged work should show remote cache hits.

## Rotation and recovery

When builds become slow or server logs show `403`, rerun the primary setup
command with its force flag. It must reject stale candidates and rewrite the
single primary file with a working token. Do not hand-copy a replacement into
individual worktrees; their read-through is the propagation mechanism.

## Silently wrong cached builds

L2 replays a bad result to every runner, so a CI-only failure that reruns do
not fix, such as `Can't resolve '@repo/<lib>'` in consumers while local builds
pass, can be a poisoned entry. Check whether two targets cache the same file.
`@nx/js/typescript` infers `typecheck` (`tsc --build tsconfig.json
--emitDeclarationOnly`) and `build` (`tsc --build tsconfig.lib.json`) and lists
the library's `dist/tsconfig.lib.tsbuildinfo` in both targets' outputs. A
restored typecheck then hands the next real build a record saying the
JavaScript is already emitted. The build emits declarations only, and that
build gets cached and replayed too. Keep build-owned tsbuildinfo out of
typecheck's outputs: sprinkles#6235 sets an explicit
`targetDefaults.typecheck.outputs` in `nx.json` that lists the declarations and
typecheck-owned records and omits `dist/tsconfig.lib.tsbuildinfo`. Editing
`nx.json` changes every task hash, which orphans the poisoned entries.
