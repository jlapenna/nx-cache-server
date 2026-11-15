# Verification

Run the same core gate documented for contributors:

```bash
npm run verify
docker compose config -q
```

For container or ownership changes, also run the same check CI's `verify`
job runs (keep each `&&` at a line end; `sh` rejects a line that starts with one):

```bash
docker build --tag nx-cache-server:local apps/nx-cache-server
docker run --rm --entrypoint /bin/sh nx-cache-server:local -c \
  'test -r /app/server.js &&
   test "$(stat -c %U:%G /app/server.js)" = node:node &&
   test -x /app/canary.sh'
```

The expected owners come from `apps/nx-cache-server/Dockerfile`: the server
runs as `node`, so it must be able to read `server.js`, while `canary.sh` is
root-owned and read-only because hosts execute it. If a change intentionally
moves the runtime user, update the Dockerfile, this check and the PR's security
summary together rather than relaxing the assertion.

Use focused targets while iterating (`npm run lint`, `npm test`, or the
relevant Nx target), but do not substitute them for the final gate. Confirm
`git diff --check` and that no secret or cache data entered the diff.
