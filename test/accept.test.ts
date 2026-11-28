import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAcceptances, checkAcceptance, hashFile } from "../src/accept.js";

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
