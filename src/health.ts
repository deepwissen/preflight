import { flatFindings, type SkillRow } from "./manifest.js";

/**
 * A skill's static health — a per-skill roll-up of the signals we already compute
 * (security, scope, conflicts) plus size/cost/hygiene checks. All file-readable;
 * it deliberately does NOT include runtime metrics (usage, error-rate, latency),
 * which need telemetry a local CLI doesn't have.
 */

export type HealthStatus = "ok" | "warn" | "risk";
export interface HealthDim {
  key: string;
  status: HealthStatus;
  note: string;
}
export interface SkillHealth {
  verdict: "healthy" | "needs attention" | "at risk";
  dims: HealthDim[];
}

const BODY_LINE_LIMIT = 500; // Anthropic + Uber: keep SKILL.md bodies under ~500 lines
const HEAVY_ALWAYS_TOKENS = 200; // name+description load every prompt; ~100 is the norm

export function skillHealth(row: SkillRow): SkillHealth {
  const dims: HealthDim[] = [];

  // Security — content/bundle findings, excluding the over-broad-scope finding
  // (which gets its own, clearer "scope" dimension).
  const sec = flatFindings(row).filter((f) => f.finding.rule !== "agent-broad-command-allow");
  const secErr = sec.some((f) => f.finding.severity === "error");
  const secWarn = sec.some((f) => f.finding.severity === "warning");
  dims.push({
    key: "security",
    status: secErr ? "risk" : secWarn ? "warn" : "ok",
    note: sec.length ? `${sec.length} finding(s) — injection/secrets/integrity` : "clean",
  });

  // Scope
  if (!row.scope.declaredTools) {
    dims.push({ key: "scope", status: "warn", note: "unrestricted — no allowed-tools" });
  } else if (row.scope.broad) {
    dims.push({ key: "scope", status: "risk", note: `over-broad — ${row.scope.broadGrants.join(", ")}` });
  } else {
    dims.push({ key: "scope", status: "ok", note: row.scopeLabel });
  }

  // Size — oversized bodies cost context and, per Uber, can hurt performance.
  dims.push(
    row.lines > BODY_LINE_LIMIT
      ? { key: "size", status: "warn", note: `body ${row.lines} lines (>${BODY_LINE_LIMIT} — move reference out)` }
      : { key: "size", status: "ok", note: `${row.lines} lines` }
  );

  // Cost — the always-on tax (name + description, every prompt).
  dims.push(
    row.alwaysTokens > HEAVY_ALWAYS_TOKENS
      ? { key: "cost", status: "warn", note: `heavy — ~${row.alwaysTokens}t every prompt` }
      : { key: "cost", status: "ok", note: `~${row.alwaysTokens}t always-on` }
  );

  // Hygiene — a missing description means the model can't route to the skill.
  const missing: string[] = [];
  if (!row.scope.name) missing.push("name");
  if (!row.scope.description) missing.push("description");
  dims.push(
    missing.length
      ? { key: "hygiene", status: "warn", note: `missing ${missing.join(" + ")}` }
      : { key: "hygiene", status: "ok", note: "name + description present" }
  );

  const hasRisk = dims.some((d) => d.status === "risk");
  const hasWarn = dims.some((d) => d.status === "warn");
  return { verdict: hasRisk ? "at risk" : hasWarn ? "needs attention" : "healthy", dims };
}
