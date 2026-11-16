# preflight

**Get your AI agent flight-ready — see what skills it's carrying, what they're cleared to do, and what they cost, before it flies.**

`preflight` is a local CLI for managing the skills your AI coding agent carries
(`.claude/skills`, slash commands, subagents, plugin-bundled skills). It's the
companion to [`vet`](https://github.com/deepwissen/vet) (which scans your *code*) —
`preflight` manages your *agent*. Same engine
([`@deepwissen/preflight-core`](https://github.com/deepwissen/preflight-core)).

## Install

```bash
npx @deepwissen/preflight manifest      # run without installing
npm i -g @deepwissen/preflight          # or install the `preflight` command
```

## `preflight manifest`

Inventory every skill your agent carries, with its **declared scope**, **static
token footprint**, and a **scan** of each:

```bash
preflight manifest                     # scan the current project
preflight manifest ./path              # scan a specific directory
preflight manifest --json              # machine-readable
preflight manifest --sarif             # SARIF 2.1.0 → GitHub code scanning
preflight manifest --fail-on warning   # exit 1 on warning or worse
```

Exit code is `0` clean, `1` if any finding meets the `--fail-on` threshold
(`error` by default; `warning` or `any` to be stricter) — so it doubles as a CI gate.

## Gate skills in CI

Your CI already scans dependencies and secrets. Gate the agent skills your team
commits the same way — fail the PR if a committed skill is over-broad, injected,
or ships a secret in a bundled script:

```yaml
# .github/workflows/skills.yml
- run: npx @deepwissen/preflight manifest --sarif > skills.sarif
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: skills.sarif }
# or hard-fail the PR:
- run: npx @deepwissen/preflight manifest --fail-on warning
```

## Manage skills

```bash
preflight list                 # compact list of installed skills
preflight add ./some-skill     # stage → scan → install (only if clean)
preflight add owner/repo       # same, from a GitHub repo (shallow clone)
preflight add ./x --dry-run    # scan and report, install nothing
preflight add ./x --force      # install despite findings
preflight remove <name>        # preview what would be removed
preflight remove <name> --yes  # move it to .preflight-trash/ (reversible)
```

### Project vs personal skills

Skills live at two levels, and both load into your agent. By default preflight acts
on **project** skills (`./.claude/skills`); `--global` acts on **personal** skills
(`~/.claude/skills`); `--all` lists both together with a WHERE column.

```bash
preflight list                 # project skills
preflight list --global        # personal skills (~/.claude/skills)
preflight list --all           # both, with a project/user column
preflight add ./x --global     # install into personal skills
preflight remove foo --global  # remove a personal skill
```

`add` is a **security gate, not a copy**: a skill from anywhere is untrusted
instructions plus code, so it's staged and scanned first and installed only if it's
clean (gate defaults to `--fail-on warning`). `remove` never hard-deletes — it moves
the skill to `.preflight-trash/`, which discovery ignores.

## Honest limits

- **Footprint is static** — a skill's description loads into context on every prompt,
  its body on demand. The numbers are an estimate of that static cost, not live usage.
- **Scope is declared-only** — it reflects a skill's `allowed-tools`; prose in the body
  can instruct the agent to do more, which a static read can't capture.
- **A scan never certifies a skill "safe"** — it surfaces known-bad patterns (prompt
  injection, hidden unicode, role-tag spoofing, embedded secrets, over-broad scope).
  A clean result means nothing was *found*, not that nothing is *there*.

All analysis is **local** — nothing is modified or sent anywhere.
