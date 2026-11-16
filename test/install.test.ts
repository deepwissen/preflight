import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitRef, planInstall, installItem, removeSkill } from "../src/install.js";

let work: string; // a "source" tree
let proj: string; // the target project

function writeSkill(base: string, name: string, body: string, scripts: Record<string, string> = {}) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  for (const [p, c] of Object.entries(scripts)) {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", p), c);
  }
  return dir;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "preflight-src-"));
  proj = mkdtempSync(join(tmpdir(), "preflight-proj-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

describe("isGitRef", () => {
  it("recognizes owner/repo and git URLs, not local paths", () => {
    expect(isGitRef("anthropics/skills")).toBe(true);
    expect(isGitRef("https://github.com/x/y.git")).toBe(true);
    expect(isGitRef("git@github.com:x/y.git")).toBe(true);
    expect(isGitRef(work)).toBe(false); // an existing local path
    expect(isGitRef("./local/dir")).toBe(false);
  });
});

describe("planInstall", () => {
  it("plans every SKILL.md skill with scan result and destination", () => {
    writeSkill(work, "good", "---\nname: good\nallowed-tools: Read\n---\nSummarize.\n");
    writeSkill(work, "risky", "---\nname: risky\nallowed-tools: Bash(*)\n---\nDo it.\n");
    const plan = planInstall(work, proj);
    expect(plan.map((p) => p.name).sort()).toEqual(["good", "risky"]);
    expect(plan.find((p) => p.name === "risky")!.row.errorCount).toBeGreaterThan(0);
    expect(plan.every((p) => !p.exists)).toBe(true);
  });
});

describe("installItem", () => {
  it("copies a skill (with bundled scripts) into .claude/skills, and flags collisions", () => {
    writeSkill(work, "deployer", "---\nname: deployer\nallowed-tools: Read\n---\nGo.\n", {
      "run.sh": "#!/bin/sh\necho hi\n",
    });
    const [item] = planInstall(work, proj);
    installItem(item, {});
    expect(existsSync(join(proj, ".claude/skills/deployer/SKILL.md"))).toBe(true);
    expect(existsSync(join(proj, ".claude/skills/deployer/scripts/run.sh"))).toBe(true);

    // second install without overwrite is refused
    const [again] = planInstall(work, proj);
    expect(again.exists).toBe(true);
    expect(() => installItem(again, {})).toThrow(/already installed/);
    expect(() => installItem(again, { overwrite: true })).not.toThrow();
  });
});

describe("removeSkill", () => {
  it("previews without --yes, then moves to .preflight-trash with --yes", () => {
    writeSkill(work, "tmp-skill", "---\nname: tmp-skill\nallowed-tools: Read\n---\nGo.\n");
    installItem(planInstall(work, proj)[0], {});
    const skillPath = join(proj, ".claude/skills/tmp-skill");
    expect(existsSync(skillPath)).toBe(true);

    const preview = removeSkill(proj, "tmp-skill", {});
    expect(preview).toMatchObject({ files: 1 });
    expect(existsSync(skillPath)).toBe(true); // untouched

    const done = removeSkill(proj, "tmp-skill", { yes: true });
    expect(done).toHaveProperty("removed");
    expect(existsSync(skillPath)).toBe(false);
    expect(existsSync(join(proj, ".preflight-trash/tmp-skill/SKILL.md"))).toBe(true);
  });

  it("errors on an unknown skill", () => {
    expect(removeSkill(proj, "nope", { yes: true })).toHaveProperty("error");
  });
});
