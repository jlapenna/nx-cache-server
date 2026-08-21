# Nx Cache Server Agent Rules

The repository development source of truth is
`.agents/skills/nx-cache-server-dev/SKILL.md`. Read it and its relevant
references before any edit, Git mutation, verification, or pull-request work.

Repository skills live under `.agents/skills/`; Codex discovers them through
`.agents/skills/.claude-plugin/marketplace.json`, and Claude Code through the
`.claude/skills` symlink. The primary checkout remains a clean `main`; all
implementation and commits use a linked worktree initialized by
`./tools/setup-worktree.sh`.

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
