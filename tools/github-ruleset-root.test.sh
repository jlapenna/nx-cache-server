#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="$root/infra/github-ruleset/main.tf"

# The root must remain self-contained so fork pull requests can initialize and
# validate it without a credential for another private fleet repository.
grep -Fqx '  owner = "jlapenna"' "$config"
grep -Fqx '  repository  = "nx-cache-server"' "$config"
grep -Fqx '        context = "validate / repository validation"' "$config"
grep -Fqx '        context = "verify"' "$config"
grep -Fqx '        context = "repository-owned Terraform"' "$config"
if grep -Fq 'source = "git::https://github.com/jlapenna/homelab.git' "$config"; then
  echo "github-ruleset root must not import Homelab source" >&2
  exit 1
fi

echo "repository-owned GitHub ruleset contract passed"
