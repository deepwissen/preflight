import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { findSkillFiles } from "./discover.js";
import { yellow, dim } from "./color.js";

export type ScopeName = "project" | "user";

export interface Scope {
  name: ScopeName;
  scanRoot: string; // directory findSkillFiles walks
  skillsDir: string; // where skills are installed / removed
  skip: string[]; // extra directory names to skip while walking scanRoot
  settingsFiles: string[]; // settings.json files whose `hooks` block to audit
}

// Claude Code keeps non-skill data under ~/.claude; never walk those when scanning
// the user scope (projects/ holds transcripts and can be enormous).
const USER_NOISE = [
  "projects",
  "todos",
  "statsig",
  "shell-snapshots",
  "ide",
  "logs",
  "history",
  "plugins",
  "backups",
];

/** Project scope: the committed, team-shared skills in <cwd>/.claude/skills. */
export function projectScope(cwd = process.cwd()): Scope {
  const root = resolve(cwd);
  const claude = join(root, ".claude");
  return {
    name: "project",
    scanRoot: root,
    skillsDir: join(claude, "skills"),
    skip: [],
    settingsFiles: [join(claude, "settings.json"), join(claude, "settings.local.json")],
  };
}

/** User scope: personal skills in ~/.claude/skills, shared across all projects. */
export function userScope(): Scope {
  const base = join(homedir(), ".claude");
  return {
    name: "user",
    scanRoot: base,
    skillsDir: join(base, "skills"),
    skip: USER_NOISE,
    settingsFiles: [join(base, "settings.json"), join(base, "settings.local.json")],
  };
}

/** Pick the scopes a command should act on from --global / --all flags. */
export function scopesFor(flags: { global?: boolean; all?: boolean }): Scope[] {
  if (flags.all) return [projectScope(), userScope()];
  if (flags.global) return [userScope()];
  return [projectScope()];
}

/** Lightweight list of a scope's skill names (lowercased) — reads only each
 *  file's frontmatter `name` (falling back to the directory/filename), no scan. */
export function scopeSkillNames(scope: Scope): string[] {
  const names: string[] = [];
  for (const rel of findSkillFiles(scope.scanRoot, scope.skip)) {
    let name = "";
    try {
      const head = readFileSync(join(scope.scanRoot, rel), "utf8").slice(0, 2000);
      const m = /^[ \t]*name[ \t]*:[ \t]*(.+?)[ \t]*$/m.exec(head);
      if (m) name = m[1].replace(/^["']|["']$/g, "");
    } catch {
      /* unreadable — fall through to path derivation */
    }
    if (!name) {
      const file = basename(rel);
      name = /^skill\.md$/i.test(file) ? basename(dirname(rel)) : file.replace(/\.md$/i, "");
    }
    if (name) names.push(name.toLowerCase());
  }
  return names;
}

/**
 * Cross-scope hints for a single-scope view: warn when a shown skill is shadowed
 * by (or shadows) a same-named skill in the other scope, and nudge that the other
 * scope's skills aren't shown. Personal (user) always wins over project. Pure.
 */
export function shadowNotices(opts: {
  shown: string[]; // names in the shown scope (lowercased)
  other: string[]; // names in the other scope (lowercased)
  global: boolean; // true when the shown scope is the user (personal) scope
  command: string; // "manifest" | "list"
}): string[] {
  const otherSet = new Set(opts.other);
  const collisions = [...new Set(opts.shown)].filter((n) => otherSet.has(n)).sort();
  const notices: string[] = [];
  for (const name of collisions) {
    notices.push(
      yellow(
        opts.global
          ? `  ⚠ "${name}" also exists as a project skill — this personal one runs; the project one is shadowed.`
          : `  ⚠ "${name}" is also a personal skill (~/.claude) — the personal one runs; this project one is shadowed.`
      )
    );
  }
  if (opts.other.length > 0) {
    const label = opts.global ? "project" : "personal";
    notices.push(
      dim(`  ℹ ${opts.other.length} ${label} skill(s) not shown — run \`preflight ${opts.command} --all\` to include them.`)
    );
  }
  return notices;
}
