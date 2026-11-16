import {
  mkdtempSync,
  cpSync,
  rmSync,
  renameSync,
  mkdirSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve, relative } from "node:path";
import { findSkillFiles, resolveSkill } from "./discover.js";
import { buildRow, type SkillRow } from "./manifest.js";

/** A git ref (owner/repo or a git URL) rather than an existing local path. */
export function isGitRef(src: string): boolean {
  if (existsSync(resolve(src))) return false; // a real local path always wins
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
export function stageSource(src: string): Staging {
  const tmp = mkdtempSync(join(tmpdir(), "preflight-add-"));
  const cleanup = (): void => rmSync(tmp, { recursive: true, force: true });
  try {
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
 *  scanned, with its destination and collision status. */
export function planInstall(stagingDir: string, root: string): InstallItem[] {
  const skillsDir = join(root, ".claude", "skills");
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
export function removeSkill(root: string, name: string, opts: { yes?: boolean }): RemovePlan {
  const res = resolveSkill(root, name);
  if ("error" in res) return { error: res.error };
  if (!/(^|\/)skill\.md$/i.test(res.absPath)) {
    return { error: `remove supports SKILL.md skills only (got ${res.displayPath})` };
  }
  const skillDir = dirname(res.absPath);
  const rel = relative(root, skillDir);
  if (!rel || rel.startsWith("..")) {
    return { error: `refusing to remove ${skillDir} — outside the project` };
  }
  if (!opts.yes) return { wouldRemove: rel, files: countFiles(skillDir) };

  const trash = join(root, ".preflight-trash", basename(skillDir));
  mkdirSync(dirname(trash), { recursive: true });
  rmSync(trash, { recursive: true, force: true });
  renameSync(skillDir, trash);
  return { removed: rel };
}
