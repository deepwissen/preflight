import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shadowNotices, scopeSkillNames } from "../src/scopes.js";
import type { Scope } from "../src/scopes.js";

describe("shadowNotices", () => {
  it("project view: warns that a personal skill shadows this one, and nudges", () => {
    const n = shadowNotices({
      shown: ["deploy", "pr-review"],
      other: ["deploy", "notes"],
      global: false,
      command: "manifest",
    });
    expect(n.some((l) => l.includes('"deploy"') && l.includes("personal one runs"))).toBe(true);
    expect(n.some((l) => l.includes("2 personal skill(s) not shown"))).toBe(true);
  });

  it("global view: warns that this personal skill shadows the project one", () => {
    const n = shadowNotices({
      shown: ["deploy"],
      other: ["deploy"],
      global: true,
      command: "list",
    });
    expect(n.some((l) => l.includes("the project one is shadowed"))).toBe(true);
    expect(n.some((l) => l.includes("project skill(s) not shown"))).toBe(true);
  });

  it("no collision, no hidden scope → no notices", () => {
    expect(shadowNotices({ shown: ["a"], other: [], global: false, command: "list" })).toEqual([]);
  });

  it("nudges even when there is no collision, if the other scope has skills", () => {
    const n = shadowNotices({ shown: ["a"], other: ["b", "c"], global: false, command: "manifest" });
    expect(n).toHaveLength(1);
    expect(n[0]).toContain("2 personal skill(s) not shown");
  });
});

describe("scopeSkillNames", () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "preflight-names-"));
    const skill = (name: string, declared?: string) => {
      const dir = join(base, "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${declared ?? name}\nallowed-tools: Read\n---\nGo.\n`
      );
    };
    skill("deploy");
    skill("dir-name", "declared-name"); // frontmatter name wins over dir name
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("reads the declared frontmatter name (lowercased)", () => {
    const scope: Scope = { name: "user", scanRoot: base, skillsDir: join(base, "skills"), skip: [] };
    const names = scopeSkillNames(scope).sort();
    expect(names).toEqual(["declared-name", "deploy"]);
  });
});
