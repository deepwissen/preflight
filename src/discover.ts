import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isSkillScopeFile } from "@deepwissen/preflight-core";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

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
