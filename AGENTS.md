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
jlapenna/agent-lcars#1325). The hosted control plane at lcars.jlapenna.net
authorizes and dispatches every headless agent run;
`.github/workflows/{claude,codex,opencode}.yml` are thin callers of the
reusable lane workflows published by jlapenna/agent-lcars (see that repo's
docs/published-actions.md), and `agent-automerge.yml` auto-merges
agent-authored PRs the same way. Dispatched agents follow agent-lcars's
**agent-protocol** skill (takeover comment, parking, deliverable evidence)
and its **lcars** delta, and the fleet claims issues as `agent-lcars-bot`.
The worktree rules above apply to dispatched agents too. No fleet
script copies are vendored here (agent-lcars#1328): the `fleet-*`
commands come from the fleet-tools package in jlapenna/agent-lcars,
installed on each machine's PATH with
`pnpm add -g "github:jlapenna/agent-lcars#main&path:packages/fleet-tools"`
(always `#main`; never a pinned tag or SHA). Sessions watch PRs with
`fleet-watch-prs`; hooks guard every invocation with `command -v`, so a
machine without the package degrades quietly.
