import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAcceptances, checkAcceptance, hashFile } from "../src/accept.js";
import { run } from "../src/cli.js";
import { buildManifest, exitForReport, type AcceptCtx } from "../src/manifest.js";
import { renderManifest, renderJson } from "../src/render.js";
import { renderManifestSarif } from "../src/sarif.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-accept-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeAccept(entries: unknown[], dir = root): void {
  mkdirSync(join(dir, ".preflight"), { recursive: true });
  writeFileSync(join(dir, ".preflight", "accepted.json"), JSON.stringify({ version: 1, accepted: entries }));
}

describe("scoped acceptance", () => {
  it("loads acceptances from the project root (and only valid entries)", () => {
    writeAccept([
      { rule: "r1", file: "a.sh", hash: "sha256:x", reason: "ok" },
      { rule: "bad" }, // missing fields → dropped
    ]);
    const list = loadAcceptances(root);
    expect(list).toHaveLength(1);
    expect(list[0].rule).toBe("r1");
  });

  it("suppresses a finding only when rule, file, and content hash all match", () => {
    const f = join(root, "clean.sh");
    writeFileSync(f, "rm -rf /workspace/reports\n");
    const hash = hashFile(f)!;
    const acc = [{ rule: "script-destructive", file: "clean.sh", hash, reason: "build cleanup" }];

    expect(checkAcceptance("script-destructive", "clean.sh", f, acc)?.status).toBe("accepted");
    // wrong rule / wrong file → no match
    expect(checkAcceptance("other-rule", "clean.sh", f, acc)).toBeNull();
    expect(checkAcceptance("script-destructive", "other.sh", f, acc)).toBeNull();
  });

  it("re-flags (stale) when the file changed since acceptance", () => {
    const f = join(root, "clean.sh");
    writeFileSync(f, "rm -rf /workspace/reports\n");
    const acc = [{ rule: "script-destructive", file: "clean.sh", hash: hashFile(f)!, reason: "ok" }];
    writeFileSync(f, "rm -rf ~\n"); // attacker swaps the content under an accepted finding
    expect(checkAcceptance("script-destructive", "clean.sh", f, acc)?.status).toBe("stale");
  });

  it("lapses after the expiry date", () => {
    const f = join(root, "clean.sh");
    writeFileSync(f, "x\n");
    const acc = [{ rule: "r", file: "clean.sh", hash: hashFile(f)!, reason: "ok", expires: "2020-01-01" }];
    expect(checkAcceptance("r", "clean.sh", f, acc, "2026-01-01")?.status).toBe("expired");
    expect(checkAcceptance("r", "clean.sh", f, acc, "2019-01-01")?.status).toBe("accepted");
  });

  it("INVARIANT: a bundled/staged acceptance file is never read (project root only)", () => {
    // a malicious pack ships its own acceptance under a staging dir
    const staged = join(root, "staging", "evil-pack");
    writeAccept([{ rule: "script-reverse-shell", file: "x.sh", hash: "sha256:any", reason: "trust me" }], staged);
    // we only ever read the PROJECT ROOT, which has none
    expect(loadAcceptances(root)).toEqual([]);
  });
});

describe("accept command (write path)", () => {
  let cwd: string;
  const out: string[] = [];
  const err: string[] = [];
  const o = (s: string) => void out.push(s);
  const e = (s: string) => void err.push(s);
  beforeEach(() => {
    cwd = process.cwd();
    process.chdir(root);
    out.length = 0;
    err.length = 0;
  });
  afterEach(() => process.chdir(cwd));

  it("records a reasoned, hash-pinned acceptance that then suppresses the finding", async () => {
    writeFileSync(join(root, "clean.sh"), "rm -rf /workspace/reports\n");
    const code = await run(["accept", "script-destructive@clean.sh", "--reason", "build cleanup"], o, e);
    expect(code).toBe(0);
    const list = loadAcceptances(root);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ rule: "script-destructive", file: "clean.sh", reason: "build cleanup" });
    expect(list[0].hash).toBe(hashFile(join(root, "clean.sh")));
    expect(list[0].acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // and the gate now treats it as accepted
    expect(checkAcceptance("script-destructive", "clean.sh", join(root, "clean.sh"), list)?.status).toBe("accepted");
  });

  it("requires a reason", async () => {
    writeFileSync(join(root, "clean.sh"), "x\n");
    const code = await run(["accept", "r@clean.sh"], o, e);
    expect(code).toBe(2);
    expect(err.join("")).toMatch(/reason/i);
    expect(loadAcceptances(root)).toEqual([]);
  });

  it("refuses an acceptance for a file that isn't in the project", async () => {
    const code = await run(["accept", "r@missing.sh", "--reason", "nope"], o, e);
    expect(code).toBe(2);
    expect(err.join("")).toMatch(/no such file/i);
  });

  it("rejects a malformed <rule>@<file> spec and a bad --expires", async () => {
    writeFileSync(join(root, "clean.sh"), "x\n");
    expect(await run(["accept", "noatsign", "--reason", "x"], o, e)).toBe(2);
    expect(await run(["accept", "r@clean.sh", "--reason", "x", "--expires", "June"], o, e)).toBe(2);
  });

  it("replaces an existing rule+file entry rather than duplicating it", async () => {
    writeFileSync(join(root, "clean.sh"), "a\n");
    await run(["accept", "r@clean.sh", "--reason", "first"], o, e);
    writeFileSync(join(root, "clean.sh"), "b\n"); // content changed → re-accept
    await run(["accept", "r@clean.sh", "--reason", "second", "--expires", "2030-01-01"], o, e);
    const list = loadAcceptances(root);
    expect(list).toHaveLength(1);
    expect(list[0].reason).toBe("second");
    expect(list[0].expires).toBe("2030-01-01");
    expect(list[0].hash).toBe(hashFile(join(root, "clean.sh")));
  });

  it("--prune drops stale and expired entries, keeps active ones", async () => {
    writeFileSync(join(root, "a.sh"), "a\n");
    writeFileSync(join(root, "b.sh"), "b\n");
    writeFileSync(join(root, "c.sh"), "c\n");
    await run(["accept", "r@a.sh", "--reason", "active"], o, e);
    await run(["accept", "r@b.sh", "--reason", "will-expire", "--expires", "2000-01-01"], o, e);
    await run(["accept", "r@c.sh", "--reason", "will-go-stale"], o, e);
    writeFileSync(join(root, "c.sh"), "changed\n"); // c.sh now stale
    const code = await run(["accept", "--prune"], o, e);
    expect(code).toBe(0);
    const list = loadAcceptances(root);
    expect(list.map((a) => a.file)).toEqual(["a.sh"]);
  });

  it("--list reports each acceptance", async () => {
    writeFileSync(join(root, "a.sh"), "a\n");
    await run(["accept", "r@a.sh", "--reason", "because"], o, e);
    out.length = 0;
    const code = await run(["accept", "--list"], o, e);
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/a\.sh/);
    expect(out.join("")).toMatch(/because/);
  });
});

describe("accepted findings render across surfaces (slice 3)", () => {
  // A skill whose only finding is an over-broad Bash grant in its SKILL.md.
  const skillRel = ".claude/skills/reports/SKILL.md";
  let rule: string;
  let accept: AcceptCtx;

  beforeEach(() => {
    const dir = join(root, ".claude", "skills", "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: reports\ndescription: build reports\nallowed-tools: Read, Bash\n---\nRun the build.\n"
    );
    const report = buildManifest(root);
    rule = report.rows[0].findings[0].rule; // the over-broad-scope finding
    accept = { acceptances: loadAcceptances(root), projectRoot: root };
  });

  function doAccept(reason = "build needs Bash", expires?: string): void {
    writeAccept([
      { rule, file: skillRel, hash: hashFile(join(root, skillRel))!, reason, ...(expires ? { expires } : {}) },
    ]);
    accept = { acceptances: loadAcceptances(root), projectRoot: root };
  }

  it("excludes an accepted finding from the --fail-on gate but still renders it, tagged", () => {
    const before = buildManifest(root);
    expect(exitForReport(before, "warning")).toBe(1); // fires before acceptance
    doAccept("build needs Bash");
    const after = buildManifest(root);
    expect(exitForReport(after, "warning", accept)).toBe(0); // suppressed from the gate
    // but NOT hidden — the manifest still shows it, tagged with the reason
    const text = renderManifest(after, accept);
    expect(text).toContain("[accepted: build needs Bash]");
  });

  it("JSON output carries an `accepted` field on the finding", () => {
    doAccept("reviewed");
    const parsed = JSON.parse(renderJson(buildManifest(root), accept));
    expect(parsed.skills[0].findings[0].accepted).toBe("reviewed");
  });

  it("SARIF emits a suppression (not an open alert) for an accepted finding", () => {
    doAccept("reviewed in PR #12");
    const sarif = JSON.parse(renderManifestSarif(buildManifest(root), accept));
    const result = sarif.runs[0].results.find((r: { ruleId: string }) => r.ruleId === rule);
    expect(result.suppressions).toEqual([{ kind: "external", justification: "reviewed in PR #12" }]);
  });

  it("a stale acceptance (file changed) is NOT suppressed and is flagged for re-review", () => {
    doAccept("build needs Bash");
    // tamper: change the file after acceptance
    writeFileSync(join(root, skillRel), "---\nname: reports\nallowed-tools: Bash\n---\nrm -rf ~\n");
    const after = buildManifest(root);
    expect(exitForReport(after, "warning", accept)).toBe(1); // fires again
    expect(renderManifest(after, accept)).toContain("acceptance stale");
  });
});

describe("accept applies to `add` — install path + staged content (slice 4)", () => {
  let cwd: string;
  const out: string[] = [];
  const err: string[] = [];
  const o = (s: string) => void out.push(s);
  const e = (s: string) => void err.push(s);
  const SKILL = "---\nname: pack\ndescription: a pack\nallowed-tools: Read, Bash\n---\nBuild.\n";

  beforeEach(() => {
    cwd = process.cwd();
    process.chdir(root);
    out.length = 0;
    err.length = 0;
    mkdirSync(join(root, "pack"), { recursive: true });
    writeFileSync(join(root, "pack", "SKILL.md"), SKILL);
  });
  afterEach(() => process.chdir(cwd));

  it("blocks a new install with a finding, but suppresses it after the installed file is accepted", async () => {
    // 1. no acceptance → blocked
    expect(await run(["add", "./pack", "--pick", "all", "--dry-run", "--fail-on", "warning"], o, e)).toBe(1);
    // 2. install it (--force past the one-time gate)
    expect(await run(["add", "./pack", "--pick", "all", "--force", "--fail-on", "warning"], o, e)).toBe(0);
    const rule = buildManifest(root).rows.find((r) => r.name === "pack")!.findings[0].rule;
    // 3. accept the finding on the INSTALLED file
    expect(await run(["accept", `${rule}@.claude/skills/pack/SKILL.md`, "--reason", "pack needs Bash"], o, e)).toBe(0);
    // 4. re-adding identical content is no longer blocked
    out.length = 0;
    expect(await run(["add", "./pack", "--pick", "all", "--overwrite", "--dry-run", "--fail-on", "warning"], o, e)).toBe(0);
    expect(out.join("")).toMatch(/would install/);
    expect(out.join("")).toMatch(/accepted via/);
  });

  it("re-flags when the staged content differs from the accepted (installed) hash", async () => {
    await run(["add", "./pack", "--pick", "all", "--force", "--fail-on", "warning"], o, e);
    const rule = buildManifest(root).rows.find((r) => r.name === "pack")!.findings[0].rule;
    await run(["accept", `${rule}@.claude/skills/pack/SKILL.md`, "--reason", "ok"], o, e);
    // the source pack now ships DIFFERENT content than what was accepted
    writeFileSync(join(root, "pack", "SKILL.md"), SKILL + "\nrm -rf ~\n");
    out.length = 0;
    err.length = 0;
    expect(await run(["add", "./pack", "--pick", "all", "--overwrite", "--dry-run", "--fail-on", "warning"], o, e)).toBe(1);
    expect(err.join("") + out.join("")).toMatch(/acceptance stale|would be BLOCKED/);
  });

  it("INVARIANT: a bundled .preflight/accepted.json in the pack is ignored (still blocked)", async () => {
    mkdirSync(join(root, "pack", ".preflight"), { recursive: true });
    writeFileSync(
      join(root, "pack", ".preflight", "accepted.json"),
      JSON.stringify({
        version: 1,
        accepted: [{ rule: "agent-broad-command-allow", file: ".claude/skills/pack/SKILL.md", hash: "sha256:any", reason: "self-accept" }],
      })
    );
    // the pack's own acceptance must NOT pre-clear its finding
    expect(await run(["add", "./pack", "--pick", "all", "--dry-run", "--fail-on", "warning"], o, e)).toBe(1);
    // and nothing was written to the project root's policy file
    expect(loadAcceptances(root)).toEqual([]);
  });
});
