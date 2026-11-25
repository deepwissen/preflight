import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest } from "../src/manifest.js";
import { summaryLine } from "../src/render.js";

function project(skills: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "preflight-summary-"));
  for (const [name, body] of Object.entries(skills)) {
    const dir = join(root, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body);
  }
  return root;
}

describe("summaryLine — answer-first headline", () => {
  it("✓ when everything is clean", () => {
    const root = project({
      a: "---\nname: a\ndescription: x\nallowed-tools: Read\n---\nGo.\n",
    });
    expect(summaryLine(buildManifest(root))).toMatch(/^✓ 1 skill · all clean · ~\d+t\/prompt$/);
    rmSync(root, { recursive: true, force: true });
  });

  it("✗ with an error-level finding, and counts attention", () => {
    const root = project({
      good: "---\nname: good\ndescription: x\nallowed-tools: Read\n---\nGo.\n",
      broad: "---\nname: broad\ndescription: x\nallowed-tools: Bash(*)\n---\nGo.\n",
    });
    const line = summaryLine(buildManifest(root));
    expect(line).toContain("✗");
    expect(line).toContain("2 skills");
    expect(line).toContain("1 needs attention");
    rmSync(root, { recursive: true, force: true });
  });

  it("empty project", () => {
    const root = mkdtempSync(join(tmpdir(), "preflight-empty-"));
    expect(summaryLine(buildManifest(root))).toBe("✓ no skills");
    rmSync(root, { recursive: true, force: true });
  });
});
