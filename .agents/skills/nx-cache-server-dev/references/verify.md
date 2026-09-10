# Verification

After `./tools/setup-worktree.sh`, use the shared executable plan:

```bash
npx --no-install repo-verify --base origin/main
npx --no-install repo-verify --base origin/main --run
```

[The plan](../../../../.repo/verify.json) owns the same native Nx, Compose,
container build, and ownership checks used by CI. It does not skip them for
documentation changes. The shared validation workflow consumes its `docs` and
`workflows` checks. Docker must be available; this builds a local test image,
not a production deployment.

For iteration, select a check with `--check native`. Full verification remains
required before completion. CI passes immutable refs; local selection includes
uncommitted and untracked changes. Failures and unavailable bases stop the run.

[Interfaces](../../../../docs/interfaces.md) are generated with
`npx --no-install repo-docs generate --output docs/interfaces.md`. Documentation
contracts reject drift, malformed skill frontmatter, and broken literal local
file links in changed Markdown; they do not verify URLs or heading anchors.
Review the diff for credentials or cache data and run `git diff --check`.
