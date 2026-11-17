import { flatFindings, type ManifestReport, type SkillRow } from "./manifest.js";
import { detectCollisions, detectAmbiguities, analyzeConflicts } from "./collisions.js";

function tok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function bytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function checkCell(r: SkillRow): string {
  if (r.errorCount) return `✗ ${r.errorCount} issue${r.errorCount > 1 ? "s" : ""}`;
  if (r.warnCount) return `⚠ ${r.warnCount} issue${r.warnCount > 1 ? "s" : ""}`;
  return "✓ clean";
}

/** Render the agent-skill manifest as the human "loadout" screen. */
export function renderManifest(report: ManifestReport): string {
  const { rows } = report;
  if (rows.length === 0) {
    return `Preflight · manifest\n${report.root}\n\nNo agent skills found (.claude/skills, commands, agents, or SKILL.md).`;
  }

  const nameW = Math.max(6, ...rows.map((r) => (r.name ?? r.path).length));
  const scopeW = Math.max(14, ...rows.map((r) => r.scopeLabel.length));
  const showWhere = rows.some((r) => r.origin);
  const whereHdr = showWhere ? `${pad("WHERE", 8)}  ` : "";
  const L: string[] = [];

  L.push("Preflight · manifest");
  L.push(report.root);
  L.push("");
  L.push("AGENT LOADOUT — what your agent is carrying");
  L.push(
    `  ${pad("SKILL", nameW)}  ${pad("SCOPE", scopeW)}  ${whereHdr}${pad("ALWAYS", 7)}  ${pad("ON-DEMAND", 9)}  CHECK`
  );
  L.push(`  ${"─".repeat(nameW + scopeW + (showWhere ? 10 : 0) + 7 + 9 + 6 + 12)}`);
  for (const r of rows) {
    const flag = r.errorCount ? " ⚠" : "  ";
    const where = showWhere ? `${pad(r.origin ?? "", 8)}  ` : "";
    L.push(
      `  ${pad((r.name ?? r.path) + flag, nameW + 2)}${pad(r.scopeLabel, scopeW)}  ${where}${pad(
        tok(r.alwaysTokens) + "t",
        7
      )}  ${pad(tok(r.onDemandTokens) + "t", 9)}  ${checkCell(r)}`
    );
  }
  L.push("");
  L.push(
    `  always-on footprint  ~${tok(report.alwaysTotal)}t every prompt   (${rows.length} skill description${
      rows.length > 1 ? "s" : ""
    })`
  );
  L.push(`  full-load footprint  ~${tok(report.onDemandTotal)}t if every body loads`);

  const flagged = rows.filter((r) => flatFindings(r).length > 0);
  if (flagged.length) {
    L.push("");
    L.push(`NEEDS ATTENTION  (${flagged.length})`);
    for (const r of flagged) {
      L.push("");
      L.push(`  ${r.errorCount ? "✗" : "⚠"} ${r.name ?? r.path}      ${r.path}`);
      for (const { file, finding: f } of flatFindings(r)) {
        const where = file !== r.path ? `${file}: ` : "";
        L.push(`     • [${f.severity}] ${where}${f.message}${f.line ? ` (line ${f.line})` : ""}`);
      }
      L.push(`     → preflight check ${r.name ?? r.path}`);
    }
  }

  const clean = rows.filter((r) => flatFindings(r).length === 0).map((r) => r.name ?? r.path);
  if (clean.length) {
    L.push("");
    L.push(`CLEAN  (${clean.length})  ${clean.join(" · ")}`);
  }

  const collisions = detectCollisions(rows);
  const ambiguities = detectAmbiguities(rows);
  if (collisions.length || ambiguities.length) {
    L.push("");
    L.push(`CONFLICTS  (${collisions.length + ambiguities.length})`);
    for (const c of collisions) {
      L.push("");
      if (c.sameScope) {
        L.push(`  ⚠ ${c.shadowed.length} skills named "${c.name}" in the same scope — resolution is unspecified`);
        for (const s of c.shadowed) L.push(`       ${s.path}`);
      } else {
        const losers = c.shadowed.map((s) => s.origin).join("/");
        L.push(`  ⚠ name "${c.name}" — ${c.winner!.origin} shadows ${losers} (only the ${c.winner!.origin} one runs)`);
        L.push(`       wins:     ${c.winner!.path}  (${c.winner!.origin})`);
        for (const s of c.shadowed) L.push(`       shadowed: ${s.path}  (${s.origin})`);
      }
    }
    for (const a of ambiguities) {
      L.push("");
      L.push(
        `  ⚠ "${a.a.name}" ↔ "${a.b.name}" — overlapping descriptions (${Math.round(
          a.similarity * 100
        )}%); the agent may pick either`
      );
    }
  }

  L.push("");
  L.push("─".repeat(78));
  L.push("Footprint is static (descriptions load always, bodies on demand — not every");
  L.push("prompt). Scope is what each skill DECLARES; prose can instruct more. Checks find");
  L.push("known-bad patterns — they don't certify a skill safe.");
  return L.join("\n");
}

/** Compact one-line-per-skill listing of what's installed. */
export function renderList(report: ManifestReport): string {
  const { rows } = report;
  if (rows.length === 0) return "No agent skills installed.";
  const nameW = Math.max(4, ...rows.map((r) => (r.name ?? r.path).length));
  const scopeW = Math.max(10, ...rows.map((r) => r.scopeLabel.length));
  const showWhere = rows.some((r) => r.origin);
  const lines = rows.map((r) => {
    const check = r.errorCount ? `✗ ${r.errorCount}` : r.warnCount ? `⚠ ${r.warnCount}` : "✓";
    const where = showWhere ? `${pad(r.origin ?? "", 8)}  ` : "";
    return `  ${pad(r.name ?? r.path, nameW)}  ${pad(r.scopeLabel, scopeW)}  ${where}${check}`;
  });
  const nConflict = detectCollisions(rows).length + detectAmbiguities(rows).length;
  if (nConflict) {
    lines.push(`  ⚠ ${nConflict} conflict(s) — run: preflight manifest${showWhere ? " --all" : ""}`);
  }
  return lines.join("\n");
}

/** Render a single skill's detailed check view (the manifest drill-in). */
export function renderCheck(row: SkillRow): string {
  const s = row.scope;
  const L: string[] = [];
  L.push(`Preflight · check — ${row.name ?? row.path}`);
  L.push(row.path);
  L.push("");
  L.push(`  ${row.name ?? row.path}${s.description ? ` — ${s.description}` : ""}`);

  L.push("");
  L.push("SCOPE (declared)");
  if (!s.declaredTools) {
    L.push("  (no allowed-tools — may inherit the session's full tool access)");
  } else {
    L.push(`  tools:    ${s.tools.map((t) => t.raw).join(", ") || "(none)"}`);
    if (s.broad) {
      L.push(`  ⚠ broad:  ${s.broadGrants.join(", ")}  — unrestricted; can act beyond this skill's job`);
    }
  }
  if (s.mcpServers.length) L.push(`  MCP:      ${s.mcpServers.join(", ")}`);
  if (s.referencedScripts.length) {
    L.push(`  scripts:  ${s.referencedScripts.join(", ")}  (runs bundled code — review it)`);
  }

  L.push("");
  L.push("FOOTPRINT");
  L.push(`  ~${tok(row.alwaysTokens)}t always     name + description, loaded every prompt`);
  L.push(`  ~${tok(row.onDemandTokens)}t on demand  full body, loaded when the skill is invoked`);

  const b = row.bundle;
  if (b.scripts.length || b.otherFiles) {
    L.push("");
    const other = b.otherFiles ? `, ${b.otherFiles} other file${b.otherFiles > 1 ? "s" : ""}` : "";
    L.push(`BUNDLED FILES (${b.scripts.length} script${b.scripts.length === 1 ? "" : "s"}${other})`);
    for (const sc of b.scripts) {
      const errs = sc.findings.filter((f) => f.severity === "error").length;
      const st = errs
        ? `✗ ${sc.findings.length} issue${sc.findings.length > 1 ? "s" : ""}`
        : sc.findings.length
          ? `⚠ ${sc.findings.length} issue${sc.findings.length > 1 ? "s" : ""}`
          : "✓ clean";
      L.push(`  ${pad(sc.path, 30)}${pad(bytes(sc.bytes), 9)} ${st}`);
    }
  }

  const flat = flatFindings(row);
  L.push("");
  if (flat.length === 0) {
    L.push("FINDINGS (0)");
    L.push("  ✓ nothing flagged — but a clean scan means nothing was found, not that");
    L.push("    nothing is there; scope above is declared-only.");
  } else {
    L.push(`FINDINGS (${flat.length})`);
    for (const { file, finding: f } of flat) {
      const mark = f.severity === "error" ? "✗" : f.severity === "warning" ? "⚠" : "ℹ";
      const where = file !== row.path ? ` in ${file}` : "";
      L.push("");
      L.push(`  ${mark} [${f.severity}] ${f.rule}${f.line ? `  (line ${f.line})` : ""}${where}`);
      L.push(`    ${f.message}`);
      if (f.suggestion) L.push(`    → ${f.suggestion}`);
    }
  }
  return L.join("\n");
}

/** Machine-readable single-skill check. */
export function renderCheckJson(row: SkillRow): string {
  return JSON.stringify(
    {
      path: row.path,
      name: row.name,
      scope: {
        label: row.scopeLabel,
        declaredTools: row.scope.declaredTools,
        tools: row.scope.tools.map((t) => t.raw),
        broad: row.scope.broad,
        broadGrants: row.scope.broadGrants,
        mcpServers: row.scope.mcpServers,
        referencedScripts: row.scope.referencedScripts,
      },
      alwaysTokens: row.alwaysTokens,
      onDemandTokens: row.onDemandTokens,
      findings: row.findings,
      bundle: row.bundle,
    },
    null,
    2
  );
}

/** Machine-readable manifest. */
export function renderJson(report: ManifestReport): string {
  return JSON.stringify(
    {
      root: report.root,
      alwaysTotal: report.alwaysTotal,
      onDemandTotal: report.onDemandTotal,
      conflicts: analyzeConflicts(report.rows),
      skills: report.rows.map((r) => ({
        path: r.path,
        name: r.name,
        scope: {
          label: r.scopeLabel,
          declaredTools: r.scope.declaredTools,
          tools: r.scope.tools.map((t) => t.raw),
          broad: r.scope.broad,
          broadGrants: r.scope.broadGrants,
          mcpServers: r.scope.mcpServers,
          referencedScripts: r.scope.referencedScripts,
        },
        alwaysTokens: r.alwaysTokens,
        onDemandTokens: r.onDemandTokens,
        findings: r.findings,
        bundle: r.bundle,
      })),
    },
    null,
    2
  );
}
