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
jlapenna/agent-lcars#1325). Everything that is true of _every_ member --
dispatch topology, the `@main` reference policy, agent conventions, the
`agent-lcars-bot` claim identity, fleet tooling, the credential rule -- is
in [`.agents/fleet-membership.md`](.agents/fleet-membership.md).

That file is canonical in jlapenna/agent-lcars and kept byte-identical here
by `.github/canonical-sync.conf`, which `validate.yml` checks on every pull
request (agent-lcars#1340 B9). Edit it there, never here.

The worktree rules above are this repo's own, and they apply to dispatched
agents too.
