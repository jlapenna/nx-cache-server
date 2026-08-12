# Contributing

## Development

The primary checkout is reserved for a clean `main`. Create a linked feature
worktree for edits, then run `./tools/setup-worktree.sh` there. Use
`./tools/setup-repo.sh` only when initializing the primary checkout.

Codex and Claude sessions use the repository hook configuration in
`.codex/hooks.json` and `.claude/settings.json`. Commands using `gh issue view`
or `gh issue edit` are checked for the `jclaw-bot` issue claim and matching
tmux title before hands-on work continues.

The active GitHub `Protect main` ruleset requires the `Verify` check, pull
requests with resolved review threads, linear history, and disallows force
pushes and branch deletion.

Use the Node version in [`.nvmrc`](.nvmrc), then install the locked
development dependencies:

```bash
./tools/setup-repo.sh
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
