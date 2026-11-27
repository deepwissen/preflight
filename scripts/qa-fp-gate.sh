#!/usr/bin/env bash
# False-positive regression gate: Anthropic's own skills must scan CLEAN.
#
# Three times now, broadening a rule has re-introduced a false positive on
# anthropics/skills (claude-api especially), which would force users to pass
# --force — and once they learn that, they pass it on real attacks too. This gate
# makes "official skills install without --force" a hard release requirement.
#
# Pair it with the attack suite (pfsuite) for both directions: real attacks must
# stay flagged, and Anthropic's skills must stay clean.
#
# Usage: PF="node ./dist/bin.js" bash scripts/qa-fp-gate.sh
#        (PF defaults to the published package via npx)
set -euo pipefail

PF="${PF:-npx -y @deepwissen/preflight@latest}"
SK="$(mktemp -d)/skills"
trap 'rm -rf "$(dirname "$SK")"' EXIT

echo "→ cloning anthropics/skills…"
git clone --depth 1 --quiet https://github.com/anthropics/skills "$SK"

echo "→ gate: $PF add <skills> --dry-run --fail-on warning  (must exit 0)"
if $PF add "$SK" --dry-run --fail-on warning; then
  echo "✓ PASS — Anthropic's skills install without --force"
else
  echo "✗ FAIL — a false positive on anthropics/skills would force --force. Do not publish."
  exit 1
fi
