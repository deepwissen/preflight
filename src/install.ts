import {
  mkdtempSync,
  cpSync,
  rmSync,
  renameSync,
  mkdirSync,
  existsSync,
  statSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { relPosix } from "./paths.js";
import { findSkillFiles, resolveSkill } from "./discover.js";
import { buildRow, type SkillRow } from "./manifest.js";

/** A git ref (owner/repo or a git URL) rather than an existing local path. */
export function isGitRef(src: string): boolean {
  if (existsSync(resolve(src))) return false; // a real local path always wins
  if (/^(\.\.?[/\\]|[/\\]|~)/.test(src)) return false; // explicit local path (./ ../ / ~), even if missing
  return /^(https?:\/\/|git@)/.test(src) || /^[\w.-]+\/[\w.-]+$/.test(src);
}

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "skill";
}

export interface Staging {
  dir: string;
  cleanup: () => void;
}

/** Copy/clone a source into a throwaway directory so it can be scanned before it
 *  ever touches the project. Caller MUST call cleanup(). */
/** A GitHub "tree"/"blob" browser URL → the cloneable repo, its branch, and the
 *  subpath the user actually wants (people paste these straight from the address bar).
 *  `https://github.com/owner/repo/tree/main/skills/pdf` → clone owner/repo@main, use
 *  skills/pdf. Returns null for a plain repo URL. */
export function parseGitHubTreeUrl(src: string): { url: string; branch: string; sub: string } | null {
  const m = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(?:tree|blob)\/([^/]+)\/(.+?)\/?$/.exec(src);
  if (!m) return null;
  return { url: `https://github.com/${m[1]}/${m[2]}.git`, branch: m[3], sub: m[4] };
}

export function stageSource(src: string): Staging {
  const tmp = mkdtempSync(join(tmpdir(), "preflight-add-"));
  const cleanup = (): void => rmSync(tmp, { recursive: true, force: true });
  try {
    const tree = parseGitHubTreeUrl(src);
    if (tree) {
      execFileSync(
        "git",
        ["clone", "--depth", "1", "--quiet", "--branch", tree.branch, tree.url, join(tmp, "repo")],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      const subDir = join(tmp, "repo", tree.sub);
      if (!existsSync(subDir)) throw new Error(`"${tree.sub}" is not in that repo`);
      return { dir: subDir, cleanup };
    }
    if (isGitRef(src)) {
      const url = /^(https?:|git@)/.test(src) ? src : `https://github.com/${src}.git`;
      execFileSync("git", ["clone", "--depth", "1", "--quiet", url, join(tmp, "repo")], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      const abs = resolve(src);
      if (!existsSync(abs)) throw new Error(`no such source: ${src}`);
      const root = statSync(abs).isFile() ? dirname(abs) : abs;
      cpSync(root, join(tmp, basename(root)), { recursive: true });
    }
    return { dir: tmp, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

export interface InstallItem {
  name: string;
  srcDir: string; // the skill's directory inside staging
  destDir: string; // where it will be installed
  row: SkillRow; // scan result
  exists: boolean; // a skill is already installed under this name
}

/** Plan what `add` would install: every SKILL.md-based skill in the staging dir,
 *  scanned, with its destination (under `skillsDir`) and collision status. */
export function planInstall(stagingDir: string, skillsDir: string): InstallItem[] {
  const items: InstallItem[] = [];
  for (const rel of findSkillFiles(stagingDir)) {
    if (!/(^|\/)skill\.md$/i.test(rel)) continue; // dir-based skills only (not lone commands)
    const abs = join(stagingDir, rel);
    const row = buildRow(abs, rel);
    const srcDir = dirname(abs);
    const name = sanitizeName(basename(srcDir) || row.name || "skill");
    const destDir = join(skillsDir, name);
    items.push({ name, srcDir, destDir, row, exists: existsSync(destDir) });
  }
  return items;
}

/**
 * Parse an interactive/`--pick` selection string into 0-based item indices.
 * Accepts numbers and ranges ("1,4,6", "1-3 5"), plus "all"/"*" and ""/"none".
 */
export function parseSelection(
  input: string,
  count: number
): { indices: number[] } | { error: string } {
  const s = input.trim().toLowerCase();
  if (s === "" || s === "none") return { indices: [] };
  if (s === "all" || s === "*") return { indices: Array.from({ length: count }, (_, i) => i) };

  const picked = new Set<number>();
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      let [a, b] = [Number(range[1]), Number(range[2])];
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n++) {
        if (n < 1 || n > count) return { error: `selection out of range: ${n} (have 1-${count})` };
        picked.add(n - 1);
      }
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n < 1 || n > count) return { error: `selection out of range: ${n} (have 1-${count})` };
      picked.add(n - 1);
    } else {
      return { error: `not a number or range: "${part}"` };
    }
  }
  return { indices: [...picked].sort((a, b) => a - b) };
}

/** Install names that collide (same install folder) — the later would shadow the earlier.
 *  Returns each colliding name once. */
export function nameCollisions(items: InstallItem[]): string[] {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.name.toLowerCase(), (counts.get(it.name.toLowerCase()) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

/** Select planned items by skill name (--only), matching dir name or declared name.
 *  `ambiguous` names match more than one skill (picking one would silently shadow). */
export function selectByNames(
  items: InstallItem[],
  names: string[]
): { selected: InstallItem[]; notFound: string[]; ambiguous: string[] } {
  const byName = new Map<string, InstallItem[]>();
  const add = (k: string, it: InstallItem): void => {
    const list = byName.get(k) ?? [];
    if (!list.includes(it)) list.push(it);
    byName.set(k, list);
  };
  for (const it of items) {
    add(it.name.toLowerCase(), it);
    if (it.row.name) add(it.row.name.toLowerCase(), it);
  }
  const selected: InstallItem[] = [];
  const notFound: string[] = [];
  const ambiguous: string[] = [];
  for (const raw of names) {
    const matches = byName.get(raw.trim().toLowerCase());
    if (!matches || matches.length === 0) notFound.push(raw.trim());
    else if (matches.length > 1) ambiguous.push(raw.trim());
    else if (!selected.includes(matches[0])) selected.push(matches[0]);
  }
  return { selected, notFound, ambiguous };
}

/** Copy one planned skill into .claude/skills (overwriting only when asked). */
export function installItem(item: InstallItem, opts: { overwrite?: boolean }): void {
  if (item.exists && !opts.overwrite) {
    throw new Error(`already installed: ${item.name} (use --overwrite to replace)`);
  }
  if (item.exists) rmSync(item.destDir, { recursive: true, force: true });
  mkdirSync(dirname(item.destDir), { recursive: true });
  cpSync(item.srcDir, item.destDir, { recursive: true });
}

function countFiles(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) n += countFiles(p);
    else n++;
  }
  return n;
}

export type RemovePlan =
  | { removed: string }
  | { wouldRemove: string; files: number }
  | { error: string };

/**
 * Remove an installed skill — reversibly. Resolves it by name/path, refuses
 * anything that isn't a SKILL.md-based skill directory (so a shared commands/
 * agents dir can never be deleted), and moves it to .preflight-trash/ rather than
 * hard-deleting. Without `yes` it reports what would happen and changes nothing.
 */
export function removeSkill(
  root: string,
  name: string,
  opts: { yes?: boolean; skip?: string[] }
): RemovePlan {
  const res = resolveSkill(root, name, opts.skip ?? []);
  if ("error" in res) return { error: res.error };
  if (!/(^|[\\/])skill\.md$/i.test(res.absPath)) {
    return { error: `remove supports SKILL.md skills only (got ${res.displayPath})` };
  }
  const skillDir = dirname(res.absPath);
  const rel = relPosix(root, skillDir);
  if (!rel || rel.startsWith("..")) {
    return { error: `refusing to remove ${skillDir} — outside the project` };
  }
  if (!opts.yes) return { wouldRemove: rel, files: countFiles(skillDir) };

  const trashRoot = join(root, ".preflight-trash");
  const trash = join(trashRoot, basename(skillDir));
  mkdirSync(trashRoot, { recursive: true });
  // Make the trash self-ignoring so a new user never accidentally commits it —
  // a `.gitignore` of `*` hides the whole folder (including itself) from git.
  writeFileSync(join(trashRoot, ".gitignore"), "*\n");
  rmSync(trash, { recursive: true, force: true });
  renameSync(skillDir, trash);
  return { removed: rel };
}
