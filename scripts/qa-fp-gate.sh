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
# Pin a specific commit so the gate is reproducible — a new upstream skill can't block a
# publish unexpectedly. Bump this deliberately when you want to test against newer skills.
SKILLS_SHA="e4bb5d960d87126ff3b3a8af1a104b7db67560ba"
SK="$(mktemp -d)/skills"
trap 'rm -rf "$(dirname "$SK")"' EXIT

echo "→ fetching anthropics/skills @ ${SKILLS_SHA:0:12}…"
git init -q "$SK"
git -C "$SK" remote add origin https://github.com/anthropics/skills
git -C "$SK" fetch -q --depth 1 origin "$SKILLS_SHA"
git -C "$SK" checkout -q FETCH_HEAD

echo "→ gate: $PF add <skills> --dry-run --fail-on warning  (must exit 0)"
if $PF add "$SK" --dry-run --fail-on warning; then
  echo "✓ PASS — Anthropic's skills install without --force"
else
  echo "✗ FAIL — a false positive on anthropics/skills would force --force. Do not publish."
  exit 1
fi
