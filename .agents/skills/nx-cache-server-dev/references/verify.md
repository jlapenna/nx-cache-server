# Verification

Run the same core gate documented for contributors:

```bash
npm run verify
docker compose config -q
```

For container or ownership changes, also run:

```bash
docker build --tag nx-cache-server:local apps/nx-cache-server
docker run --rm --entrypoint /bin/sh nx-cache-server:local -c \
  'test -r /app/server.js && test "$(stat -c %U:%G /app/server.js)" = node:node'
```

Use focused targets while iterating (`npm run lint`, `npm test`, or the
relevant Nx target), but do not substitute them for the final gate. Confirm
`git diff --check` and that no secret or cache data entered the diff.
