import { readFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, relative, resolve } from "node:path";
import { extractSkillScope, type SkillScope } from "@deepwissen/preflight-core";
import { findSkillFiles, findContextFiles, contextKind } from "./discover.js";
import { relPosix } from "./paths.js";
import { checkAcceptance, type Acceptance } from "./accept.js";
import { scanSkill, scanInstruction, scanMcpConfig, type Finding } from "./scan.js";
import { enumerateBundle, type Bundle } from "./bundle.js";
import { scanSettings } from "./hooks.js";
import type { Scope, ScopeName } from "./scopes.js";

/** Static token footprint ~ chars/4. Honest approximation for a per-file number;
 *  the real cost is conditional (descriptions load always, bodies on demand). */
function estTokens(text: string): number {
  return Math.round(text.length / 4);
}

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
  "TodoWrite",
]);

/** A short, legible description of what a skill is cleared to do. */
export function scopeLabel(scope: SkillScope): string {
  if (!scope.declaredTools) return "unrestricted (no allowed-tools)";
  if (scope.broad) return scope.broadGrants.join(", ");
  const toolNames = scope.tools.map((t) => t.tool);
  const parts: string[] = [];
  if (toolNames.length > 0 && toolNames.every((t) => READ_ONLY_TOOLS.has(t) || t.startsWith("mcp__"))) {
    parts.push(scope.mcpServers.length ? "read-only+MCP" : "read-only");
  } else {
    const shown = scope.tools
      .filter((t) => !t.tool.startsWith("mcp__"))
      .map((t) => t.raw)
      .slice(0, 3);
    parts.push(shown.join(", ") || "scoped");
  }
  if (scope.mcpServers.length && !parts[0].includes("MCP")) {
    parts.push(`MCP:${scope.mcpServers.join("/")}`);
  }
  return parts.join(", ");
}

export interface SkillRow {
  path: string;
  name: string | null;
  scope: SkillScope;
  scopeLabel: string;
  alwaysTokens: number;
  onDemandTokens: number;
  lines: number; // body line count (for the size health check)
  findings: Finding[]; // the SKILL.md's own findings
  bundle: Bundle; // scripts the skill ships, each scanned
  errorCount: number; // across the skill AND its bundle
  warnCount: number;
  origin?: ScopeName; // which scope it came from (set in combined/--all views)
}

/** Every finding for a skill — its own plus each bundled script's — tagged with the
 *  file it came from (the skill path, or a bundled script's relative path). */
export function flatFindings(row: SkillRow): Array<{ file: string; finding: Finding }> {
  const out = row.findings.map((finding) => ({ file: row.path, finding }));
  for (const sc of row.bundle.scripts) {
    for (const finding of sc.findings) out.push({ file: sc.path, finding });
  }
  return out;
}

/** An always-on instruction/context file (CLAUDE.md or a .claude/rules/*.md): loaded
 *  every session, grants no tools, but carries token cost and injection risk. */
export interface ContextRow {
  path: string;
  kind: "rule" | "context";
  alwaysTokens: number; // whole body loads at session start
  findings: Finding[];
  errorCount: number;
  warnCount: number;
}

export interface ManifestReport {
  root: string;
  rows: SkillRow[];
  contextFiles: ContextRow[]; // CLAUDE.md + .claude/rules/*.md — always-on, non-tool context
  alwaysTotal: number;
  onDemandTotal: number;
  settingsRisks: LocatedFinding[]; // config-risk findings from scope settings.json files
}

/** Build one context-file row: always-on token cost + an instruction-integrity scan. */
// Claude Code `@path` imports in a CLAUDE.md pull another file's content into context
// (recursively). preflight must follow them, or injection hidden one hop away in
// `@docs/agent.md` is invisible. Require a file-ish path (has an extension) and that
// it's preceded by whitespace/start so `user@example.com` isn't treated as an import.
const IMPORT_RE = /(?:^|[\s(])@((?:~\/|\.{0,2}\/)?[\w.\-/]+\.\w+)/g;

function scanImports(fromAbs: string, content: string, seen: Set<string>, depth: number): Finding[] {
  if (depth > 3) return []; // bounded — imports can chain, but don't recurse forever
  const out: Finding[] = [];
  const base = dirname(fromAbs);
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(content))) {
    const raw = m[1];
    const abs = resolve(base, raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!existsSync(abs)) continue;
    let imported: string;
    try {
      imported = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const f of scanInstruction(`@${raw}`, imported)) {
      out.push({ ...f, message: `imported @${raw}: ${f.message}` });
    }
    out.push(...scanImports(abs, imported, seen, depth + 1));
  }
  return out;
}

export function buildContextRow(absPath: string, displayPath: string): ContextRow {
  const content = readFileSync(absPath, "utf8");
  const findings = [...scanInstruction(displayPath, content), ...scanImports(absPath, content, new Set([absPath]), 0)];
  return {
    path: displayPath,
    kind: contextKind(displayPath) === "rule" ? "rule" : "context",
    alwaysTokens: estTokens(content),
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warnCount: findings.filter((f) => f.severity === "warning").length,
  };
}

/** Build one skill's row: scope + footprint + scan. `displayPath` is what's shown
 *  and what the engine classifies by (must end in SKILL.md or sit under
 *  .claude/{skills,commands,agents}); `absPath` is where the content is read from. */
export function buildRow(absPath: string, displayPath: string): SkillRow {
  const content = readFileSync(absPath, "utf8");
  const scope = extractSkillScope(displayPath, content);
  const findings = scanSkill(displayPath, content);
  const bundle = enumerateBundle(absPath);
  const all = [...findings, ...bundle.scripts.flatMap((s) => s.findings)];
  return {
    path: displayPath,
    name: scope.name,
    scope,
    scopeLabel: scopeLabel(scope),
    alwaysTokens: estTokens(`${scope.name ?? ""} ${scope.description ?? ""}`.trim()),
    onDemandTokens: estTokens(content),
    lines: content.split("\n").length,
    findings,
    bundle,
    errorCount: all.filter((f) => f.severity === "error").length,
    warnCount: all.filter((f) => f.severity === "warning").length,
  };
}

export type FailOn = "error" | "warning" | "any";
const RANK: Record<Finding["severity"], number> = { info: 1, warning: 2, error: 3 };

export interface LocatedFinding {
  file: string; // repo-root-relative
  rule: string;
  severity: Finding["severity"];
  message: string;
  line?: number;
  accepted?: string; // reason, when a .preflight/accepted.json entry suppresses it from the gate
  acceptStale?: boolean; // an acceptance existed but the file changed — fires + "re-review"
}

/** Context for honoring `.preflight/accepted.json` (read from the project root only). */
export interface AcceptCtx {
  acceptances: Acceptance[];
  projectRoot: string;
}

/** Every finding across the report, each with a repo-root-relative path — bundled
 *  scripts are re-rooted from skill-dir-relative to repo-relative for reporting. */
export function reportFindings(report: ManifestReport, accept?: AcceptCtx): LocatedFinding[] {
  const annotate = (f: LocatedFinding): LocatedFinding => {
    if (!accept || accept.acceptances.length === 0) return f;
    const abs = f.file.startsWith("~/") ? join(homedir(), f.file.slice(2)) : join(accept.projectRoot, f.file);
    const v = checkAcceptance(f.rule, f.file, abs, accept.acceptances);
    if (v?.status === "accepted") return { ...f, accepted: v.reason };
    if (v?.status === "stale") return { ...f, acceptStale: true };
    return f;
  };
  const out: LocatedFinding[] = [];
  for (const r of report.rows) {
    // Under --all, a user-scope path is relative to ~/.claude and otherwise looks
    // identical to a project path (skills/x/SKILL.md). Prefix it so code-scanning /
    // SARIF consumers can tell personal skills from committed ones.
    const prefix = r.origin === "user" ? "~/.claude/" : "";
    for (const f of r.findings) {
      out.push(annotate({ file: prefix + r.path, rule: f.rule, severity: f.severity, message: f.message, line: f.line }));
    }
    const dir = dirname(r.path);
    for (const sc of r.bundle.scripts) {
      const uri = prefix + (dir === "." ? sc.path : `${dir}/${sc.path}`);
      for (const f of sc.findings) {
        out.push(annotate({ file: uri, rule: f.rule, severity: f.severity, message: f.message, line: f.line }));
      }
    }
  }
  for (const c of report.contextFiles) {
    for (const f of c.findings) {
      out.push(annotate({ file: c.path, rule: f.rule, severity: f.severity, message: f.message, line: f.line }));
    }
  }
  out.push(...report.settingsRisks.map(annotate));
  return out;
}

/** Config-risk findings from a scope's settings.json files, each as a LocatedFinding
 *  with a readable path (project: `.claude/settings.json`; user: `~/.claude/...`). */
function scopeSettingsRisks(scope: Scope): LocatedFinding[] {
  const home = homedir();
  const out: LocatedFinding[] = [];
  for (const sf of scope.settingsFiles) {
    const file = scope.name === "user" ? sf.replace(home, "~") : relPosix(scope.scanRoot, sf) || sf;
    for (const f of scanSettings(sf)) {
      out.push({ file, rule: f.rule, severity: f.severity, message: f.message, line: f.line });
    }
  }
  // Project-level MCP config (.mcp.json at the repo root): risky servers (a server that
  // runs curl|sh), embedded secrets, injected tool descriptions.
  if (scope.name === "project") {
    const mcp = join(scope.scanRoot, ".mcp.json");
    if (existsSync(mcp)) {
      let content: string | null = null;
      try {
        content = readFileSync(mcp, "utf8");
      } catch {
        content = null;
      }
      if (content !== null) {
        let valid = true;
        try {
          JSON.parse(content);
        } catch {
          valid = false;
        }
        if (!valid) {
          // Consistent with invalid settings.json (which warns) — don't silently skip a
          // malformed MCP config; a hidden server could be in there.
          out.push({
            file: ".mcp.json",
            rule: "mcp-unparseable",
            severity: "warning",
            message: ".mcp.json is not valid JSON — its servers can't be audited",
          });
        } else {
          for (const f of scanMcpConfig(".mcp.json", content)) {
            out.push({ file: ".mcp.json", rule: f.rule, severity: f.severity, message: f.message, line: f.line });
          }
        }
      }
    }
  }
  // MCP servers in ~/.claude.json — where `claude mcp add` writes by default, and the
  // surface preflight most easily misses. Top-level mcpServers are global (user scope);
  // projects[<cwd>].mcpServers are scoped to one project (project scope). Either can wire
  // the agent to a server that runs curl|sh.
  const claudeJson = join(home, ".claude.json");
  if (existsSync(claudeJson)) {
    try {
      const j = JSON.parse(readFileSync(claudeJson, "utf8")) as {
        mcpServers?: unknown;
        projects?: Record<string, { mcpServers?: unknown } | undefined>;
      };
      let servers = scope.name === "user" ? j.mcpServers : undefined;
      if (scope.name === "project" && j.projects && typeof j.projects === "object") {
        // Match the project key by realpath — the stored key may differ from cwd by a
        // symlink (/tmp vs /private/tmp) or trailing slash.
        const real = (p: string): string => {
          try {
            return realpathSync(p);
          } catch {
            return p.replace(/\/+$/, "");
          }
        };
        const target = real(scope.scanRoot);
        for (const [key, val] of Object.entries(j.projects)) {
          if (key === scope.scanRoot || real(key) === target) {
            servers = val?.mcpServers;
            break;
          }
        }
      }
      const label = scope.name === "user" ? "~/.claude.json" : "~/.claude.json (local)";
      if (servers && typeof servers === "object") {
        for (const f of scanMcpConfig(label, JSON.stringify({ mcpServers: servers }))) {
          out.push({ file: label, rule: f.rule, severity: f.severity, message: f.message, line: f.line });
        }
      }
    } catch {
      /* corrupt ~/.claude.json — skip here */
    }
  }
  return out;
}

export function failThreshold(failOn: FailOn): number {
  return failOn === "any" ? 1 : failOn === "warning" ? 2 : 3;
}

/** Exit 1 when any finding meets/exceeds the --fail-on threshold, else 0. */
export function exitForReport(report: ManifestReport, failOn: FailOn, accept?: AcceptCtx): number {
  const threshold = failThreshold(failOn);
  // An accepted finding (rule+file+hash match, not expired) doesn't count toward the gate.
  return reportFindings(report, accept).some((f) => !f.accepted && RANK[f.severity] >= threshold) ? 1 : 0;
}

/** Build the agent-skill manifest for a directory (optionally skipping dirs). */
export function buildManifest(root: string, skip: Iterable<string> = [], claudeRoot = false): ManifestReport {
  const rows = findSkillFiles(root, skip, claudeRoot).map((rel) => buildRow(join(root, rel), rel));
  const contextFiles = findContextFiles(root, skip, claudeRoot).map((rel) => buildContextRow(join(root, rel), rel));
  return {
    root,
    rows,
    contextFiles,
    alwaysTotal: rows.reduce((n, r) => n + r.alwaysTokens, 0),
    onDemandTotal: rows.reduce((n, r) => n + r.onDemandTokens, 0),
    settingsRisks: [],
  };
}

/** Build a manifest across one or more scopes. With multiple scopes each row is
 *  tagged with its origin (project/user) so the view can show a WHERE column. */
export function buildScopes(scopes: Scope[]): ManifestReport {
  const multi = scopes.length > 1;
  const rows: SkillRow[] = [];
  const contextFiles: ContextRow[] = [];
  const settingsRisks: LocatedFinding[] = [];
  for (const s of scopes) {
    const sub = buildManifest(s.scanRoot, s.skip, s.name === "user");
    for (const row of sub.rows) rows.push(multi ? { ...row, origin: s.name } : row);
    contextFiles.push(...sub.contextFiles);
    settingsRisks.push(...scopeSettingsRisks(s));
  }
  return {
    root: multi ? scopes.map((s) => s.name).join(" + ") : scopes[0].scanRoot,
    rows,
    contextFiles,
    alwaysTotal: rows.reduce((n, r) => n + r.alwaysTokens, 0),
    onDemandTotal: rows.reduce((n, r) => n + r.onDemandTokens, 0),
    settingsRisks,
  };
}
