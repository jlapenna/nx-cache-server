# Nx Cache Server Agent Rules

The repository development source of truth is
`.agents/skills/nx-cache-server-dev/SKILL.md`. Read it and its relevant
references before any edit, Git mutation, verification, or pull-request work.

Repository skills live under `.agents/skills/`; Codex discovers them through
`.agents/skills/.claude-plugin/marketplace.json`, and Claude Code through the
`.claude/skills` symlink. The primary checkout remains a clean `main`; all
implementation and commits use a linked worktree initialized by
`./tools/setup-worktree.sh`.
