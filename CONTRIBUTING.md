# Contributing

## Development

Use the Node version in [`.nvmrc`](.nvmrc), then install the locked
development dependencies:

```bash
npm ci
```

Run the Nx-managed checks before opening a pull request:

```bash
npm run verify
docker compose config -q
```

`npm run lint` checks the server and canary syntax. `npm test` runs the
protocol regression suite through Nx, so repeat runs can use Nx's local task
cache. The `container` target is available for a local image build:

```bash
npx nx run nx-cache-server:container
```

## Pull requests

Keep changes focused, add or update regression coverage for behavior changes,
and explain any security-sensitive changes to authentication, cache
publication, or credential handling. Never commit `.env` files, token maps, or
cache data.
