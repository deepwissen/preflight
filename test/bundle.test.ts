import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateBundle } from "../src/bundle.js";
import { buildRow, flatFindings } from "../src/manifest.js";
import { renderCheck } from "../src/render.js";

let root: string;
let skillAbs: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "preflight-bundle-"));
  const dir = join(root, ".claude", "skills", "deployer");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  skillAbs = join(dir, "SKILL.md");
  writeFileSync(
    skillAbs,
    "---\nname: deployer\ndescription: Deploy the app\nallowed-tools: Read\n---\nRun the bundled scripts.\n"
  );
  // a clean helper script
  writeFileSync(join(dir, "scripts", "build.sh"), "#!/bin/sh\nnpm run build\n");
  // a script with a hardcoded secret
  writeFileSync(
    join(dir, "scripts", "deploy.sh"),
    '#!/bin/sh\nexport AWS_KEY="AKIAIOSFODNN7EXAMPLE1"\naws s3 sync . s3://bucket\n'
  );
  // a non-script asset
  writeFileSync(join(dir, "notes.txt"), "just notes\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("enumerateBundle", () => {
  it("finds bundled scripts, counts other files, and scans each script", () => {
    const b = enumerateBundle(skillAbs);
    expect(b.scripts.map((s) => s.path).sort()).toEqual(["scripts/build.sh", "scripts/deploy.sh"]);
    expect(b.otherFiles).toBe(1); // notes.txt

    const deploy = b.scripts.find((s) => s.path === "scripts/deploy.sh")!;
    expect(deploy.language).toBe("shellscript");
    expect(deploy.findings.some((f) => f.severity === "error")).toBe(true); // the AWS key

    const build = b.scripts.find((s) => s.path === "scripts/build.sh")!;
    expect(build.findings).toEqual([]);
  });

  it("returns an empty bundle for a single-file command (no SKILL.md dir)", () => {
    const cmd = join(root, ".claude", "commands", "release.md");
    mkdirSync(join(root, ".claude", "commands"), { recursive: true });
    writeFileSync(cmd, "---\nname: release\n---\nTag and push.\n");
    const b = enumerateBundle(cmd);
    expect(b.scripts).toEqual([]);
  });
});

describe("buildRow + render with a bundle", () => {
  it("rolls bundled-script findings into the skill's counts and flat findings", () => {
    const row = buildRow(skillAbs, ".claude/skills/deployer/SKILL.md");
    expect(row.findings).toEqual([]); // the SKILL.md prose itself is clean
    expect(row.errorCount).toBeGreaterThan(0); // but the bundle has a secret
    const flat = flatFindings(row);
    expect(flat.some((f) => f.file === "scripts/deploy.sh")).toBe(true);
  });

  it("shows a BUNDLED FILES section in the check view", () => {
    const row = buildRow(skillAbs, ".claude/skills/deployer/SKILL.md");
    const view = renderCheck(row);
    expect(view).toContain("BUNDLED FILES");
    expect(view).toContain("scripts/deploy.sh");
    expect(view).toContain("in scripts/deploy.sh"); // finding attributed to the bundled file
  });
});
