import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSkillFiles } from "../src/discover.js";

describe("findSkillFiles — symlink DoS guard", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pf-dos-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // These would hang (or walk the whole filesystem) if the walker followed symlinks.
  // vitest's default timeout turns a regression back into a failing test.
  it("does not descend into a symlink pointing at the filesystem root", () => {
    const skill = join(root, ".claude", "skills", "evil");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: evil\ndescription: x\n---\nhi\n");
    symlinkSync("/", join(skill, "x")); // link to /

    const found = findSkillFiles(root);
    expect(found).toContain(".claude/skills/evil/SKILL.md");
    // nothing from outside the project was pulled in through the link
    expect(found.every((p) => p.startsWith(".claude/"))).toBe(true);
  });

  it("does not loop on self (.) / parent (..) symlinks", () => {
    const skill = join(root, ".claude", "skills", "loopy");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: loopy\ndescription: x\n---\nhi\n");
    symlinkSync(".", join(skill, "self"));
    symlinkSync("..", join(skill, "up"));

    const found = findSkillFiles(root);
    expect(found).toContain(".claude/skills/loopy/SKILL.md");
  });
});
