import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSkillScope, type SkillScope } from "@deepwissen/preflight-core";
import { findSkillFiles } from "./discover.js";
import { scanSkill, type Finding } from "./scan.js";
import { enumerateBundle, type Bundle } from "./bundle.js";

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

/** Build the agent-skill manifest for a project directory. */
export function buildManifest(root: string): ManifestReport {
  const rows = findSkillFiles(root).map((rel) => buildRow(join(root, rel), rel));
  return {
    root,
    rows,
    alwaysTotal: rows.reduce((n, r) => n + r.alwaysTokens, 0),
    onDemandTotal: rows.reduce((n, r) => n + r.onDemandTokens, 0),
  };
}
