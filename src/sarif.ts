import { reportFindings, type ManifestReport, type LocatedFinding } from "./manifest.js";

function level(s: LocatedFinding["severity"]): string {
  return s === "error" ? "error" : s === "warning" ? "warning" : "note";
}

/** Minimal SARIF 2.1.0 — consumable by GitHub code scanning for inline PR
 *  annotations. Mirrors vet's shape so both tools upload the same way. */
export function renderManifestSarif(report: ManifestReport): string {
  const findings = reportFindings(report);
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
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
