// preflight scenario harness — each scenario gets a fresh project dir + HOME.
// Usage: node harness.mjs <scenario-module.mjs> [PF command, default: npx -y @deepwissen/preflight@latest]
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const PF = (process.argv[3] || "npx -y @deepwissen/preflight@latest").split(" ");
// `node ./dist/bin.js` → make the path absolute (relative to the harness's cwd), since
// scenarios spawn with cwd=<temp project>. Cross-platform — no $PWD / %CD% shell-ism.
if (PF[0] === "node" && PF[1] && !isAbsolute(PF[1])) PF[1] = resolve(PF[1]);
const { scenarios } = await import(process.argv[2]);

function writeTree(root, tree = {}) {
  for (const [rel, content] of Object.entries(tree)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    if (content && typeof content === "object" && content.symlink) {
      // Windows needs a privilege to create symlinks; don't crash the whole run if denied.
      try {
        symlinkSync(content.symlink, p);
      } catch {
        /* skip — symlink scenarios may degrade on Windows */
      }
    }
    else if (content && typeof content === "object" && content.dir) mkdirSync(p, { recursive: true });
    else writeFileSync(p, content);
  }
}

export function run(args, cwd, home, timeout = 60000) {
  const t = Date.now();
  const r = spawnSync(PF[0], [...PF.slice(1), ...args], {
    cwd, encoding: "utf8", timeout,
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "", ms: Date.now() - t, timedOut: r.error?.code === "ETIMEDOUT" };
}

function sarifResults(stdout) {
  try { return JSON.parse(stdout).runs[0].results.map(r => ({ rule: r.ruleId, level: r.level, uri: r.locations?.[0]?.physicalLocation?.artifactLocation?.uri || "", msg: r.message?.text || "" })); }
  catch { return null; }
}

const rows = [];
const base = join(tmpdir(), "pfsuite-" + process.pid);
for (const s of scenarios) {
  const root = join(base, s.id), proj = join(root, "proj"), home = join(root, "home");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(proj, { recursive: true }); mkdirSync(home, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: proj });
  writeTree(proj, s.files); writeTree(home, s.home);
  if (s.setup) s.setup({ proj, home, root });
  const args = s.args || ["manifest", "--all", "--sarif"];
  const r = run(args.map(a => a.replace("{proj}", proj).replace("{root}", root)), proj, home, s.timeout);
  const crashed = r.timedOut || r.code === null || /\n\s+at .+\.js:\d+/.test(r.out) || /TypeError|ReferenceError|RangeError|SyntaxError: /.test(r.out);
  let pass, actual;
  const results = args.includes("--sarif") ? sarifResults(r.stdout) : null;
  const rel = (results || []).filter(x => (!s.uri || s.uri.test(x.uri)) && (!s.rule || s.rule.test(x.rule + " " + x.msg)));
  const worst = rel.some(x => x.level === "error") ? "error" : rel.some(x => x.level === "warning") ? "warning" : rel.length ? "note" : "none";
  if (crashed) { pass = false; actual = "CRASH/TIMEOUT " + r.out.split("\n").find(l => /Error|at /.test(l))?.slice(0, 90); }
  else if (s.check) { const c = s.check(r, results, { proj, home, root }); pass = c.pass; actual = c.actual; }
  else if (results === null) { pass = false; actual = "no SARIF: " + r.out.slice(0, 90).replace(/\n/g, " "); }
  else {
    actual = worst + (rel.length ? ` [${[...new Set(rel.filter(x=>x.level!=="note").map(x => x.rule))].join(",")}]` : "");
    pass = s.expect === "clean" ? (worst === "none" || worst === "note")
         : s.expect === "error" ? worst === "error"
         : (worst === "error" || worst === "warning"); // "flag"
  }
  rows.push({ id: s.id, area: s.area, desc: s.desc, expect: s.expect || "custom", actual, pass, ms: r.ms });
  process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${s.id.padEnd(6)} ${s.desc.slice(0, 62).padEnd(62)} expect=${(s.expect || "custom").padEnd(6)} got=${actual}  (${r.ms}ms)\n`);
}
const f = rows.filter(r => !r.pass).length;
console.log(`\n${rows.length - f}/${rows.length} passed, ${f} failed`);
writeFileSync(process.argv[2].replace(/\.mjs$/, ".results.json"), JSON.stringify(rows, null, 1));

process.exit(f ? 1 : 0);
