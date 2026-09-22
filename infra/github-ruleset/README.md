# Nx Cache Server GitHub ruleset

This is the repository-owned declaration for its `Protect main` GitHub
ruleset. It intentionally has no credential, state-bucket value, or backend
prefix. The trusted Homelab executor supplies those at runtime and owns the
scheduled drift check.

The root is self-contained so fork pull requests can initialize and validate
it without access to another private fleet repository. Do not run an
unconfigured local apply. Ruleset `20724994` is imported into this root's
isolated state; Homelab no longer carries the resource in its central state.

Repository CI initializes, formats, validates, and checks this root's local
contract. Only the centralized executor receives backend and state access.
