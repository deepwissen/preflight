import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSelection, selectByNames, planInstall, installItem } from "../src/install.js";

describe("parseSelection", () => {
  it("parses numbers, ranges, all, none", () => {
    expect(parseSelection("1,4,6", 6)).toEqual({ indices: [0, 3, 5] });
    expect(parseSelection("1-3 5", 6)).toEqual({ indices: [0, 1, 2, 4] });
    expect(parseSelection("all", 3)).toEqual({ indices: [0, 1, 2] });
    expect(parseSelection("", 3)).toEqual({ indices: [] });
    expect(parseSelection("none", 3)).toEqual({ indices: [] });
  });
  it("dedupes and sorts", () => {
    expect(parseSelection("3,1,3,2", 3)).toEqual({ indices: [0, 1, 2] });
  });
  it("rejects out-of-range and non-numbers", () => {
    expect("error" in parseSelection("7", 6)).toBe(true);
    expect("error" in parseSelection("1,x", 6)).toBe(true);
  });
});

describe("selectByNames + subset install", () => {
  let work: string;
  let proj: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "sel-src-"));
    proj = mkdtempSync(join(tmpdir(), "sel-proj-"));
    for (const n of ["alpha", "beta", "gamma"]) {
      const d = join(work, n);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "SKILL.md"), `---\nname: ${n}\nallowed-tools: Read\n---\nGo.\n`);
    }
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it("selects by name and reports unknowns", () => {
    const items = planInstall(work, join(proj, ".claude", "skills"));
    const r = selectByNames(items, ["beta", "nope"]);
    expect(r.selected.map((i) => i.name)).toEqual(["beta"]);
    expect(r.notFound).toEqual(["nope"]);
  });

  it("installs only the chosen subset", () => {
    const items = planInstall(work, join(proj, ".claude", "skills"));
    const pick = parseSelection("1,3", items.length);
    if ("error" in pick) throw new Error(pick.error);
    for (const i of pick.indices) installItem(items[i], {});
    expect(existsSync(join(proj, ".claude/skills/alpha/SKILL.md"))).toBe(true);
    expect(existsSync(join(proj, ".claude/skills/gamma/SKILL.md"))).toBe(true);
    expect(existsSync(join(proj, ".claude/skills/beta/SKILL.md"))).toBe(false); // not chosen
  });
});
