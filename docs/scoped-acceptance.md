# 0.6 — Scoped acceptance (design)

## The problem

`--force` is a sledgehammer. It installs a skill **ignoring every finding** — so a
developer who used `--force` once to get past a false positive learns that `--force`
is "how you make preflight shut up," and reaches for it again on the pack that later
ships a real reverse shell. A security gate only works if its blocks are rare and
correct, and if the way past a *wrong* block is **narrow** — it accepts *that one
finding*, not the next attack.

This is the feature that settles the `--force` problem. Prior art: gitleaks
`.gitleaksignore` (fingerprints), Semgrep `nosemgrep`, `npm audit` (doesn't block).
preflight's version is **hash-pinned, reasoned, expiring, and project-root-only** —
the last property is the one most of them lack and the one that matters most here.

---

## Q1 — What does an acceptance cover?

**`rule` + `file` + a content `hash`.** A finding is suppressed *from the gate* only
when an acceptance matches its rule id and file, **and** the file's current SHA-256
equals the recorded hash. Change the file at all and the hash mismatches → the finding
re-appears and must be re-reviewed. This is deliberately coarser than per-line
(line numbers drift; a hash is stable and self-invalidating) and deliberately
narrower than per-skill or per-rule-globally (you accept *this finding in this file at
this content*, nothing else).

> If a file legitimately has two findings of the same rule, `rule+file` accepts both.
> A later refinement can add an optional per-finding `fingerprint`
> (`sha256(rule + "\n" + message)`) to distinguish them; start with `rule+file+hash`.

## Q2 — Where does it live, and who reviews it?

**A committed `.preflight/accepted.json` at the project root.** Every acceptance is a
diff in a pull request — a reviewer sees *"why are we accepting a destructive-rm
finding in `clean.sh`?"* right next to the reason. That visibility **is** the feature;
a transient `--force` on someone's laptop is reviewed by no one.

```jsonc
{
  "version": 1,
  "accepted": [
    {
      "rule": "script-destructive",
      "file": "skills/reports/clean.sh",     // repo-root-relative, POSIX separators
      "hash": "sha256:ab12…",                // of the file at acceptance time
      "reason": "rm -rf /workspace/reports is our build cleanup, not an attack",
      "expires": "2026-06-01",               // optional
      "acceptedBy": "alice",                 // from git config, informational
      "acceptedAt": "2026-01-15"
    }
  ]
}
```

## Q3 — Can an attacker ship their own acceptance file? (the critical rule)

**No. The acceptance file is read ONLY from the project root — never from staged,
cloned, or scanned content.** Concretely:

- `manifest` / `check` / CI read `<cwd>/.preflight/accepted.json` only.
- `add owner/repo` **does not** read any `.preflight/accepted.json` from the staging
  dir or the pack. A malicious skill that bundles its own `.preflight/accepted.json`
  pre-accepting its reverse shell is **ignored** — that file is *content being
  vetted*, not policy.
- An acceptance can only be authored into *your* committed file (via the `accept`
  command or a hand-edit), which goes through *your* PR review.

So the exception can never be smuggled in by the thing you're vetting. This is the
invariant the whole design protects; everything else is ergonomics.

## Q4 — How does it expire, and is it hidden?

- **A `reason` is required** (non-empty) — you must articulate why.
- **`expires` is optional but encouraged** — after that date the acceptance lapses and
  the finding fires again, forcing a revisit instead of a forever-suppression.
- **Accepted findings are never hidden — they're shown dimmed**, tagged
  `[accepted: <reason>]`, and excluded from the `--fail-on` exit code. "Accepted" means
  "a human decided this is OK," not "gone." A stale hash (file changed since
  acceptance) shows the finding at full weight with an `acceptance stale — re-review` note.

---

## Command surface

```bash
preflight accept <rule>@<file> --reason "…" [--expires 2026-06-01]
      # hashes <file> now, appends an entry to .preflight/accepted.json
preflight accept --list        # show acceptances + which are expired / stale-hash
preflight accept --prune       # drop expired and stale-hash entries

preflight manifest / check / add --dry-run
      # matched findings shown dimmed [accepted: …], excluded from the gate
```

`--force` stays, but becomes the loud, logged, last resort (prints what it's
overriding) — the scoped path is what you'd actually reach for.

## Gate semantics (precise)

A finding is **suppressed from the `--fail-on` gate** iff an acceptance matches
`(rule, file)` **and** `hash == sha256(current file)` **and** (`expires` absent OR
`expires >= today`). Otherwise it fires normally. Suppressed findings are still
emitted (dimmed) in human/JSON/SARIF output with an `accepted` flag, so downstream
tools see the full picture.

## Rollout

1. Reader + gate integration + dimmed rendering (manifest/check).
2. `accept` subcommand (write path) + `--list` / `--prune`.
3. `add` integration (accept applies to already-installed; new installs still use the
   explicit flag, never a bundled file).
4. Docs + an article: *"How we let you accept a false positive without accepting the
   next attack."*
