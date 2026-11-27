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

/** Walk a project tree and return the paths (relative to `root`) that `keep` accepts. */
function walkFiles(root: string, skip: Set<string>, keep: (rel: string) => boolean): string[] {
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
        if (!skip.has(name)) walk(abs);
      } else {
        const rel = relative(root, abs);
        if (keep(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

const SKILL_MD = /(^|\/)skill\.md$/i;
const COMMAND_OR_AGENT = /(^|\/)\.claude\/(commands|agents)\/.*\.md$/i;

/**
 * Is this file itself a skill/command/agent ROW — a thing the agent loads as a unit?
 * SKILL.md (a skill owns a directory) and single-file .claude/commands|agents/*.md.
 * A helper .md nested under .claude/skills/<name>/ (reference.md, etc.) is NOT a row —
 * it's scanned via the owning skill's bundle (enumerateBundle), so it isn't double-listed
 * and `check <name>` isn't made ambiguous by it. (The engine's isSkillScopeFile matches
 * any .md under .claude/skills for scope extraction; this is the stricter row filter.)
 */
export function isSkillRow(rel: string): boolean {
  return SKILL_MD.test(rel) || COMMAND_OR_AGENT.test(rel);
}

/**
 * Walk a project tree and return the skill/command/agent ROWS the agent carries —
 * SKILL.md anywhere (incl. plugin-bundled / npx-installed) and
 * .claude/{commands,agents}/**.md. Returns paths relative to `root`.
 */
export function findSkillFiles(root: string, extraSkip: Iterable<string> = []): string[] {
  return walkFiles(root, new Set([...SKIP_DIRS, ...extraSkip]), isSkillRow);
}

// Always-on instruction/context files the agent reads every session, but which
// grant no tools: a CLAUDE.md (memory) or a .claude/rules/*.md (path-scoped rule).
const CONTEXT_PATH = /(^|\/)CLAUDE\.md$/i;
const RULE_PATH = /(^|\/)\.claude\/rules\/.*\.md$/i;

/** Classify an always-on context file: "rule", "context" (CLAUDE.md), or null. */
export function contextKind(path: string): "rule" | "context" | null {
  if (RULE_PATH.test(path)) return "rule";
  if (CONTEXT_PATH.test(path)) return "context";
  return null;
}

/** Walk a project tree for always-on context files (CLAUDE.md, .claude/rules/*.md). */
export function findContextFiles(root: string, extraSkip: Iterable<string> = []): string[] {
  return walkFiles(root, new Set([...SKIP_DIRS, ...extraSkip]), (rel) => contextKind(rel) !== null);
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
  arg: string,
  extraSkip: Iterable<string> = []
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
  for (const rel of findSkillFiles(root, extraSkip)) {
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
