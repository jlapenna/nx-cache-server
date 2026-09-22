# Nx Cache Server GitHub ruleset

This is the repository-owned declaration for its `Protect main` GitHub
ruleset. It intentionally has no credential, state-bucket value, or backend
prefix. The trusted Homelab executor supplies those at runtime and owns the
scheduled drift check.

The root is self-contained so fork pull requests can initialize and validate
it without access to another private fleet repository. Do not run an
unconfigured local apply. Until the reviewed state handoff completes,
Homelab's central module remains authoritative for the live ruleset.

Repository CI initializes, formats, validates, and checks this root's local
contract. Only the centralized executor receives backend and state access.
