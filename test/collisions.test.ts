import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScopes, buildManifest } from "../src/manifest.js";
import { detectCollisions, detectAmbiguities } from "../src/collisions.js";
import { renderManifest } from "../src/render.js";
import type { Scope } from "../src/scopes.js";

let proj: string;
let user: string;

function skill(base: string, rel: string, dir: string, body: string) {
  const d = join(base, rel, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), body);
}
const fm = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\nallowed-tools: Read\n---\nGo.\n`;

beforeAll(() => {
  proj = mkdtempSync(join(tmpdir(), "preflight-col-proj-"));
  user = mkdtempSync(join(tmpdir(), "preflight-col-user-"));
  // cross-scope name collision: 'deploy' in both
  skill(proj, ".claude/skills", "deploy", fm("deploy", "Deploy the project service"));
  skill(user, "skills", "deploy", fm("deploy", "Deploy my personal thing"));
  // description ambiguity within project: two reviewers
  skill(proj, ".claude/skills", "pr-review", fm("pr-review", "Review a pull request and summarize the code changes"));
  skill(proj, ".claude/skills", "code-review", fm("code-review", "Review the code changes in a pull request and summarize"));
  // a distinct skill that should NOT be flagged
  skill(proj, ".claude/skills", "changelog", fm("changelog", "Generate release notes from git history tags"));
});

afterAll(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(user, { recursive: true, force: true });
});

const projectScope = (): Scope => ({
  name: "project",
  scanRoot: proj,
  skillsDir: join(proj, ".claude", "skills"),
  skip: [],
});
const userScope = (): Scope => ({
  name: "user",
  scanRoot: user,
  skillsDir: join(user, "skills"),
  skip: [],
});

describe("detectCollisions", () => {
  it("names the winner by precedence (user shadows project)", () => {
    const report = buildScopes([projectScope(), userScope()]);
    const cols = detectCollisions(report.rows);
    const deploy = cols.find((c) => c.name === "deploy")!;
    expect(deploy).toBeTruthy();
    expect(deploy.sameScope).toBe(false);
    expect(deploy.winner!.origin).toBe("user");
    expect(deploy.shadowed.map((s) => s.origin)).toEqual(["project"]);
  });

  it("flags same-scope duplicates as unspecified (no winner)", () => {
    const base = mkdtempSync(join(tmpdir(), "preflight-dup-"));
    skill(base, ".claude/skills", "a", fm("dup", "first"));
    skill(base, ".claude/skills", "b", fm("dup", "second"));
    const cols = detectCollisions(buildManifest(base).rows);
    const dup = cols.find((c) => c.name === "dup")!;
    expect(dup.sameScope).toBe(true);
    expect(dup.winner).toBeUndefined();
    expect(dup.shadowed.length).toBe(2);
    rmSync(base, { recursive: true, force: true });
  });

  it("does not flag distinct names", () => {
    const cols = detectCollisions(buildManifest(proj).rows);
    expect(cols.find((c) => c.name === "changelog")).toBeUndefined();
  });
});

describe("detectAmbiguities", () => {
  it("flags skills with overlapping descriptions, not distinct ones", () => {
    const amb = detectAmbiguities(buildManifest(proj).rows);
    const pair = amb.find(
      (a) =>
        [a.a.name, a.b.name].includes("pr-review") &&
        [a.a.name, a.b.name].includes("code-review")
    );
    expect(pair).toBeTruthy();
    expect(pair!.similarity).toBeGreaterThanOrEqual(0.5);
    expect(amb.some((a) => [a.a.name, a.b.name].includes("changelog"))).toBe(false);
  });
});

describe("renderManifest — CONFLICTS section", () => {
  it("shows collisions and ambiguities with the winner spelled out", () => {
    const view = renderManifest(buildScopes([projectScope(), userScope()]));
    expect(view).toContain("CONFLICTS");
    expect(view).toContain('name "deploy" — user shadows project');
    expect(view).toContain("pr-review");
  });
});
