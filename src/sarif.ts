import { reportFindings, type ManifestReport, type LocatedFinding, type AcceptCtx } from "./manifest.js";
import type { PluginInfo } from "./plugins.js";

function level(s: LocatedFinding["severity"]): string {
  return s === "error" ? "error" : s === "warning" ? "warning" : "note";
}

export function renderManifestSarif(report: ManifestReport, accept?: AcceptCtx): string {
  return findingsToSarif(reportFindings(report, accept));
}

/** Flatten plugin audit findings to SARIF (same shape as the manifest's). */
export function renderPluginsSarif(plugins: PluginInfo[]): string {
  const findings: LocatedFinding[] = [];
  for (const p of plugins) {
    for (const { file, finding } of p.findings) {
      findings.push({ file, rule: finding.rule, severity: finding.severity, message: finding.message, line: finding.line });
    }
  }
  return findingsToSarif(findings);
}

/** Minimal SARIF 2.1.0 — consumable by GitHub code scanning for inline PR
 *  annotations. Mirrors vet's shape so both tools upload the same way. */
function findingsToSarif(findings: LocatedFinding[]): string {
  const ruleIds = [...new Set(findings.map((f) => f.rule))];
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "preflight",
            informationUri: "https://github.com/deepwissen/preflight",
            rules: ruleIds.map((id) => ({ id })),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.rule,
          level: level(f.severity),
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                ...(f.line ? { region: { startLine: f.line } } : {}),
              },
            },
          ],
          // An accepted finding is a reviewed, hash-pinned exception — emit it as a SARIF
          // suppression so GitHub code scanning shows it dismissed (reason in the
          // justification) instead of as an open alert, while it stays in the output.
          ...(f.accepted ? { suppressions: [{ kind: "external", justification: f.accepted }] } : {}),
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
