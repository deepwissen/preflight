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

**Requirements:** Node.js 18+, and `git` on your PATH for `add owner/repo`.
**Platforms:** macOS, Linux, and Windows — the test suite runs on all three in CI.

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

### Collisions & ambiguity

`manifest` also reports **conflicts** between skills:

- **Name collisions** — two skills with the same name. Personal (`~/.claude`) silently
  shadows project (`./.claude`) with no warning from Claude Code, so `manifest --all`
  spells out which one actually runs and which is dead.
- **Ambiguous descriptions** — differently-named skills whose descriptions overlap, so
  the agent's (model-driven) choice between them is unpredictable.

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
preflight add owner/repo            # clone + scan, then CHOOSE which to install
preflight add owner/repo --pick 1,4,6   # install those by number (1-3 / all also work)
preflight add owner/repo --only tdd,pr  # install these by name
preflight add ./some-skill         # a single local skill
preflight add ./x --dry-run        # scan and report, install nothing
preflight add ./x --force          # install despite findings
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

`add` is a **security gate and a chooser, not a bulk copy**: a repo of skills is
staged and scanned, then shown as a numbered list (with each skill's risk and
per-prompt token cost) so you install only the few you want — not all 39. It prompts
interactively in a terminal, or takes `--pick <numbers>` / `--only <names>`. Chosen
skills are installed only if clean (gate defaults to `--fail-on warning`). `remove` never hard-deletes — it moves
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
