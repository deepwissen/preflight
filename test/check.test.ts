import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkill } from "../src/discover.js";
import { buildRow } from "../src/manifest.js";
import { renderCheck, renderBlockedFindings } from "../src/render.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "preflight-check-"));
  const skill = (name: string, body: string) => {
    const dir = join(root, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body);
  };
  skill(
    "aws-deploy",
    "---\nname: aws-deploy\ndescription: Deploy to AWS\nallowed-tools: Read, Bash(*), mcp__aws__deploy\n---\nRun ./deploy.sh.\n"
  );
  skill(
    "pr-review",
    "---\nname: pr-review\ndescription: Review a PR\nallowed-tools: Read, Grep\n---\nSummarize.\n"
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveSkill", () => {
  it("resolves by declared name", () => {
    const r = resolveSkill(root, "aws-deploy");
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.displayPath).toContain("aws-deploy");
  });
  it("resolves by directory path", () => {
    const r = resolveSkill(root, join(root, ".claude/skills/pr-review"));
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.displayPath).toContain("pr-review");
  });
  it("errors on an unknown skill", () => {
    const r = resolveSkill(root, "does-not-exist");
    expect("error" in r).toBe(true);
  });
});

describe("renderCheck", () => {
  it("shows scope, broad warning, MCP, scripts, footprint, and findings with fixes", () => {
    const r = resolveSkill(root, "aws-deploy");
    if ("error" in r) throw new Error(r.error);
    const row = buildRow(r.absPath, r.displayPath);
    const view = renderCheck(row);

    expect(view).toContain("check — aws-deploy");
    expect(view).toContain("SCOPE (declared)");
    expect(view).toContain("Bash(*)");
    expect(view).toContain("MCP:      aws");
    expect(view).toContain("./deploy.sh");
    expect(view).toContain("FOOTPRINT");
    expect(view).toContain("FINDINGS (1)");
    expect(view).toContain("→ "); // a fix suggestion is present
    expect(row.errorCount).toBeGreaterThan(0);
  });

  it("gives a clean-but-honest view for a scoped skill", () => {
    const r = resolveSkill(root, "pr-review");
    if ("error" in r) throw new Error(r.error);
    const view = renderCheck(buildRow(r.absPath, r.displayPath));
    expect(view).toContain("FINDINGS (0)");
    expect(view).toContain("nothing was found");
  });
});

describe("renderBlockedFindings (add gate / dry-run surface the reason)", () => {
  it("lists each blocked skill's findings inline, not just a --force hint", () => {
    const r = resolveSkill(root, "aws-deploy");
    if ("error" in r) throw new Error(r.error);
    const out = renderBlockedFindings([buildRow(r.absPath, r.displayPath)]);
    expect(out).toContain("aws-deploy");
    expect(out).toContain("finding"); // "(N finding(s))"
    expect(out).toMatch(/\[(error|warning)\]/); // a severity-tagged finding line
    expect(out).not.toContain("--force"); // the reason, not just the escape hatch
  });

  it("skips skills with no findings", () => {
    const r = resolveSkill(root, "pr-review");
    if ("error" in r) throw new Error(r.error);
    expect(renderBlockedFindings([buildRow(r.absPath, r.displayPath)])).toBe("");
  });
});
