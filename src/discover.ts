import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, basename, dirname } from "node:path";
import { isSkillScopeFile, extractSkillScope } from "@deepwissen/preflight-core";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".preflight-trash",
]);

/**
 * Walk a project tree and return the skill/command/agent files the agent carries —
 * SKILL.md anywhere (incl. plugin-bundled / npx-installed) and
 * .claude/{skills,commands,agents}/**.md. Returns paths relative to `root`.
 *
 * Classification is delegated to the engine's isSkillScopeFile so discovery and
 * scope extraction never disagree about what counts as a skill.
 */
export function findSkillFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir — skip
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(abs);
      } else {
        const rel = relative(root, abs);
        if (isSkillScopeFile(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

export interface Resolved {
  absPath: string;
  displayPath: string;
}

function relOrAbs(root: string, abs: string): string {
  const r = relative(root, abs);
  return r && !r.startsWith("..") ? r : abs;
}

/**
 * Resolve a `preflight check` argument to a single skill file. Accepts a direct
 * path (to a SKILL.md or a skill directory) or a skill identifier — matched against
 * each skill's declared `name`, its containing directory, or its filename.
 */
export function resolveSkill(
  root: string,
  arg: string
): Resolved | { error: string; candidates?: string[] } {
  // 1. A direct path (relative to cwd) to a skill file or a skill directory.
  const direct = resolve(arg);
  if (existsSync(direct)) {
    const st = statSync(direct);
    if (st.isFile() && isSkillScopeFile(direct)) {
      return { absPath: direct, displayPath: relOrAbs(root, direct) };
    }
    if (st.isDirectory() && existsSync(join(direct, "SKILL.md"))) {
      const sk = join(direct, "SKILL.md");
      return { absPath: sk, displayPath: relOrAbs(root, sk) };
    }
  }

  // 2. An identifier: match declared name / directory / filename.
  const matches: Resolved[] = [];
  for (const rel of findSkillFiles(root)) {
    const abs = join(root, rel);
    const name = extractSkillScope(rel, readFileSync(abs, "utf8")).name;
    const dir = basename(dirname(rel));
    const file = basename(rel).replace(/\.md$/i, "");
    if (name === arg || dir === arg || file === arg) matches.push({ absPath: abs, displayPath: rel });
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return { error: `no skill matching "${arg}" found under ${root}` };
  return {
    error: `"${arg}" is ambiguous — it matches ${matches.length} skills; pass a path instead`,
    candidates: matches.map((m) => m.displayPath),
  };
}
