import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { extractSkillScope, type SkillScope } from "@deepwissen/preflight-core";
import { findSkillFiles } from "./discover.js";
import { scanSkill, type Finding } from "./scan.js";
import { enumerateBundle, type Bundle } from "./bundle.js";
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

export interface ManifestReport {
  root: string;
  rows: SkillRow[];
  alwaysTotal: number;
  onDemandTotal: number;
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
}

/** Every finding across the report, each with a repo-root-relative path — bundled
 *  scripts are re-rooted from skill-dir-relative to repo-relative for reporting. */
export function reportFindings(report: ManifestReport): LocatedFinding[] {
  const out: LocatedFinding[] = [];
  for (const r of report.rows) {
    for (const f of r.findings) {
      out.push({ file: r.path, rule: f.rule, severity: f.severity, message: f.message, line: f.line });
    }
    const dir = dirname(r.path);
    for (const sc of r.bundle.scripts) {
      const uri = dir === "." ? sc.path : `${dir}/${sc.path}`;
      for (const f of sc.findings) {
        out.push({ file: uri, rule: f.rule, severity: f.severity, message: f.message, line: f.line });
      }
    }
  }
  return out;
}

export function failThreshold(failOn: FailOn): number {
  return failOn === "any" ? 1 : failOn === "warning" ? 2 : 3;
}

/** Exit 1 when any finding meets/exceeds the --fail-on threshold, else 0. */
export function exitForReport(report: ManifestReport, failOn: FailOn): number {
  const threshold = failThreshold(failOn);
  return reportFindings(report).some((f) => RANK[f.severity] >= threshold) ? 1 : 0;
}

/** Build the agent-skill manifest for a directory (optionally skipping dirs). */
export function buildManifest(root: string, skip: Iterable<string> = []): ManifestReport {
  const rows = findSkillFiles(root, skip).map((rel) => buildRow(join(root, rel), rel));
  return {
    root,
    rows,
    alwaysTotal: rows.reduce((n, r) => n + r.alwaysTokens, 0),
    onDemandTotal: rows.reduce((n, r) => n + r.onDemandTokens, 0),
  };
}

/** Build a manifest across one or more scopes. With multiple scopes each row is
 *  tagged with its origin (project/user) so the view can show a WHERE column. */
export function buildScopes(scopes: Scope[]): ManifestReport {
  const multi = scopes.length > 1;
  const rows: SkillRow[] = [];
  for (const s of scopes) {
    for (const row of buildManifest(s.scanRoot, s.skip).rows) {
      rows.push(multi ? { ...row, origin: s.name } : row);
    }
  }
  return {
    root: multi ? scopes.map((s) => s.name).join(" + ") : scopes[0].scanRoot,
    rows,
    alwaysTotal: rows.reduce((n, r) => n + r.alwaysTokens, 0),
    onDemandTotal: rows.reduce((n, r) => n + r.onDemandTokens, 0),
  };
}
