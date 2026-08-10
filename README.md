# nx-cache-server

A small, dependency-free HTTP remote-cache server for Nx's built-in
`NX_SELF_HOSTED_REMOTE_CACHE_SERVER` client. It implements immutable,
content-addressed entries over Nx's native `GET` and `PUT /v1/cache/<hash>`
protocol, so a shared cache does not require a commercial adapter or a custom
task runner.

The server has no runtime dependencies. This repository is an Nx workspace:
Nx manages and caches its lint, protocol-test, and container-build tasks. Its
Node test suite covers concurrent uploads, partial/aborted uploads, immutable
publication, read-only credentials, token-map validation, and the optional
integrity canary.

## Quick start

1. Copy the example environment file and replace the placeholder token:

   ```bash
   cp .env.example .env
   # Set NX_CACHE_ACCESS_TOKEN to a random value, for example:
   # openssl rand -hex 32
   ```

2. Start the server:

   ```bash
   docker compose up --build -d
   ```

3. Configure Nx clients:

   ```bash
   export NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://cache-host:3000
   export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN='<the write token>'
   ```

The server stores cache data in the named Docker volume `nx-cache-data`.
Set `NX_CACHE_PORT`, `MAX_CACHE_GB`, or `MAX_AGE_DAYS` in `.env` when the
defaults do not fit the deployment.

## Published image

Image-relevant commits merged to `main` produce a multi-platform
(`linux/amd64` and `linux/arm64`) image at
`ghcr.io/jlapenna/nx-cache-server`. Releases stage an immutable commit tag,
scan both platform images, then promote that exact manifest to `:latest`.
Pull it directly when you do not need a local source build:

```bash
docker pull ghcr.io/jlapenna/nx-cache-server:latest
```

For a production deployment, pin the immutable commit tag or image digest
instead of the moving `:latest` tag.

## Credentials

### Legacy scalar tokens

`NX_CACHE_ACCESS_TOKEN` is required and permits reads and writes.
`NX_CACHE_READ_ONLY_ACCESS_TOKEN` is optional; it permits reads but receives
`403` for `PUT`. Keep the values distinct. Nx treats a `403` store response as
a cache-store refusal, so read-only clients still receive cache hits without
publishing entries.

### Multiple named tokens

For separate credentials per consumer, set `NX_CACHE_TOKENS_FILE` to the
absolute path of a JSON file on the Docker host. The Compose example mounts
that same path read-only into the container, avoiding token values in the
container environment.

```json
{
  "build-ci": { "role": "write", "token": "<openssl rand -hex 32>" },
  "developer": { "role": "write", "token": "<openssl rand -hex 32>" },
  "read-only-job": { "role": "read", "token": "<openssl rand -hex 32>" }
}
```

When `NX_CACHE_TOKENS_FILE` is set, it replaces both scalar-token variables.
At startup the server rejects an empty map, invalid roles, empty token values,
duplicate token values, and maps without a write-role token. Matched requests
record the credential name as `tokenName` in the structured access log; token
values are never logged.

Keep `.env` and the token-map file out of source control. Make the token-map
file readable by the container's `node` user (uid 1000).

## Protocol and behavior

Every cache request uses `Authorization: Bearer <token>`.

| Request | Result |
| --- | --- |
| `GET /healthz` | unauthenticated `200` liveness response |
| `GET` or `HEAD /v1/cache/<hash>` | `200`, `404`, or `403` |
| `PUT /v1/cache/<hash>` | `200` stored, `409` already present, or `403` for a read-only credential |

Entries are immutable. Uploads stream to a temporary file and publish via a
no-replace hard link, so readers see either a complete entry or a `404`, and
concurrent writers cannot overwrite the first published value. The backing
filesystem must support hard links.

The server removes entries older than `MAX_AGE_DAYS`, then evicts least
recently used entries until it is below `MAX_CACHE_GB`. A successful `GET`
refreshes an entry's modification time.

## Development and test

Use the Node version in [`.nvmrc`](.nvmrc) and install the locked development
dependencies:

```bash
npm ci
```

Run the Nx-managed checks:

```bash
npm run verify
```

This runs the dependency-free regression suite with `nx test
nx-cache-server`; a repeat run can use Nx's local task cache. Build a local
container image with:

```bash
npx nx run nx-cache-server:container
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## Optional integrity canary

`canary.sh` verifies a deployed cache's write, read-only read, read-only
write rejection, and immutable-conflict behavior. It passes credentials to
curl through private header files rather than command arguments or output.

With legacy scalar credentials, run it as:

```bash
NX_CACHE_ACCESS_TOKEN='<write token>' \
NX_CACHE_READ_ONLY_ACCESS_TOKEN='<read token>' \
CACHE_URL=http://127.0.0.1:3000 \
./canary.sh
```

In token-map mode, set `NX_CACHE_TOKENS_FILE` instead. The map must contain at
least one read-role and one write-role entry so the canary can verify both
authorization paths. Set `TEXTFILE_DIR` to write Prometheus node-exporter
textfile metrics; it defaults to `/var/lib/prometheus/node-exporter`.

## License

[MIT](LICENSE)
