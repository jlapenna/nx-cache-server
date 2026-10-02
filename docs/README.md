# Documentation Index

Start with the smallest document that owns the question.

| Need | Document |
| --- | --- |
| Understand component boundaries and proof | [`../ARCHITECTURE.md`](../ARCHITECTURE.md) |
| Configure and run the cache | [`../README.md`](../README.md) |
| Contribute changes | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Report or evaluate security issues | [`../SECURITY.md`](../SECURITY.md) |
| Follow the agent development workflow | [`../.agents/skills/nx-cache-server-dev/SKILL.md`](../.agents/skills/nx-cache-server-dev/SKILL.md) |
| Inspect repository protection ownership | [`../infra/github-ruleset/README.md`](../infra/github-ruleset/README.md) |

Runtime behavior belongs beside the service in `apps/nx-cache-server/`:

- `server.js` is the implementation;
- `server.test.js` is the executable protocol specification;
- `Dockerfile` is the image contract;
- `canary.sh` is the optional live integrity probe;
- `project.json` declares the Nx targets.

When adding durable documentation, link it here. Keep commands and procedures
in their owning guide rather than duplicating them in `AGENTS.md`.
