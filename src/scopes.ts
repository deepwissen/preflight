import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ScopeName = "project" | "user";

export interface Scope {
  name: ScopeName;
  scanRoot: string; // directory findSkillFiles walks
  skillsDir: string; // where skills are installed / removed
  skip: string[]; // extra directory names to skip while walking scanRoot
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
  return { name: "project", scanRoot: root, skillsDir: join(root, ".claude", "skills"), skip: [] };
}

/** User scope: personal skills in ~/.claude/skills, shared across all projects. */
export function userScope(): Scope {
  const base = join(homedir(), ".claude");
  return { name: "user", scanRoot: base, skillsDir: join(base, "skills"), skip: USER_NOISE };
}

/** Pick the scopes a command should act on from --global / --all flags. */
export function scopesFor(flags: { global?: boolean; all?: boolean }): Scope[] {
  if (flags.all) return [projectScope(), userScope()];
  if (flags.global) return [userScope()];
  return [projectScope()];
}
