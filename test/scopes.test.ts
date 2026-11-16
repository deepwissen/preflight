import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScopes } from "../src/manifest.js";
import { renderList } from "../src/render.js";
import type { Scope } from "../src/scopes.js";

let projRoot: string;
let userRoot: string; // stand-in for ~/.claude

function skill(base: string, rel: string, name: string) {
  const dir = join(base, rel, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\nallowed-tools: Read\n---\nGo.\n`);
}

beforeAll(() => {
  projRoot = mkdtempSync(join(tmpdir(), "preflight-proj-"));
  userRoot = mkdtempSync(join(tmpdir(), "preflight-user-"));
  skill(projRoot, ".claude/skills", "proj-skill");
  skill(userRoot, "skills", "user-skill");
  // noise under the user root that must be skipped
  skill(userRoot, "projects", "should-be-ignored");
});

afterAll(() => {
  rmSync(projRoot, { recursive: true, force: true });
  rmSync(userRoot, { recursive: true, force: true });
});

const projectScope = (): Scope => ({
  name: "project",
  scanRoot: projRoot,
  skillsDir: join(projRoot, ".claude", "skills"),
  skip: [],
});
const userScope = (): Scope => ({
  name: "user",
  scanRoot: userRoot,
  skillsDir: join(userRoot, "skills"),
  skip: ["projects"],
});

describe("buildScopes", () => {
  it("tags rows with origin and honors the scope skip list across both scopes", () => {
    const report = buildScopes([projectScope(), userScope()]);
    const names = report.rows.map((r) => r.name).sort();
    expect(names).toEqual(["proj-skill", "user-skill"]); // 'should-be-ignored' skipped
    expect(report.rows.find((r) => r.name === "proj-skill")!.origin).toBe("project");
    expect(report.rows.find((r) => r.name === "user-skill")!.origin).toBe("user");
  });

  it("does not tag origin for a single scope (no WHERE column)", () => {
    const report = buildScopes([projectScope()]);
    expect(report.rows.every((r) => r.origin === undefined)).toBe(true);
  });
});

describe("renderList --all", () => {
  it("shows a WHERE column with project/user for combined scopes", () => {
    const out = renderList(buildScopes([projectScope(), userScope()]));
    expect(out).toContain("proj-skill");
    expect(out).toContain("user-skill");
    expect(out).toContain("project");
    expect(out).toContain("user");
  });
});
