import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findSkillFiles } from "./discover.js";
import { buildRow, flatFindings } from "./manifest.js";
import { scanMcpConfig, type Finding } from "./scan.js";

/**
 * Audit installed Claude Code plugins (~/.claude/plugins). A plugin is a bigger
 * supply-chain surface than a standalone skill — it bundles skills + an MCP config
 * + hooks, from a third-party marketplace. Phase 1 scans the bundled SKILLS and
 * root .mcp.json (reusing our detectors) and surfaces provenance; it does NOT yet
 * scan hooks (the highest-privilege component) — see the honest caveat in the
 * output. Read-only: it audits what's installed, it never installs/removes.
 */

export interface PluginInfo {
  name: string;
  marketplace: string;
  source: string; // "github:owner/repo" | "unknown"
  skills: number;
  commands: number;
  hasMcp: boolean;
  hasHooks: boolean; // flagged but NOT yet scanned
  findings: Array<{ file: string; finding: Finding }>;
  errorCount: number;
  warnCount: number;
}

function pluginsBase(): string {
  return join(homedir(), ".claude", "plugins");
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isPluginDir(dir: string): boolean {
  return existsSync(join(dir, "plugin.json")) || existsSync(join(dir, ".claude-plugin", "plugin.json"));
}

/** marketplace name → source ("github:owner/repo"), from known_marketplaces.json. */
function marketplaceSources(base: string): Record<string, string> {
  try {
    const km = JSON.parse(readFileSync(join(base, "known_marketplaces.json"), "utf8")) as Record<
      string,
      { source?: { source?: string; repo?: string } }
    >;
    const out: Record<string, string> = {};
    for (const [name, v] of Object.entries(km)) {
      const s = v?.source;
      out[name] = s?.source === "github" && s?.repo ? `github:${s.repo}` : (s?.source ?? "unknown");
    }
    return out;
  } catch {
    return {};
  }
}

function countMd(dir: string): number {
  return safeReaddir(dir).filter((f) => /\.md$/i.test(f)).length;
}

function scanPlugin(dir: string, name: string, marketplace: string, source: string): PluginInfo {
  const findings: PluginInfo["findings"] = [];

  // Bundled skills (reuse buildRow — also scans each skill's own bundle).
  const skillFiles = findSkillFiles(dir).filter((r) => /(^|\/)skill\.md$/i.test(r));
  for (const rel of skillFiles) {
    const row = buildRow(join(dir, rel), rel);
    for (const ff of flatFindings(row)) findings.push({ file: `${name}/${ff.file}`, finding: ff.finding });
  }

  // The plugin's root MCP config.
  const mcp = join(dir, ".mcp.json");
  const hasMcp = existsSync(mcp);
  if (hasMcp) {
    for (const f of scanMcpConfig(".mcp.json", readFileSync(mcp, "utf8"))) {
      findings.push({ file: `${name}/.mcp.json`, finding: f });
    }
  }

  return {
    name,
    marketplace,
    source,
    skills: skillFiles.length,
    commands: countMd(join(dir, "commands")),
    hasMcp,
    hasHooks: existsSync(join(dir, "hooks", "hooks.json")),
    findings,
    errorCount: findings.filter((f) => f.finding.severity === "error").length,
    warnCount: findings.filter((f) => f.finding.severity === "warning").length,
  };
}

/** Discover + scan every installed plugin. Defensive: unknown layouts are skipped. */
export function discoverPlugins(): PluginInfo[] {
  const base = pluginsBase();
  const marketplaces = join(base, "marketplaces");
  if (!isDir(marketplaces)) return [];
  const sources = marketplaceSources(base);

  const out: PluginInfo[] = [];
  for (const m of safeReaddir(marketplaces)) {
    const mdir = join(marketplaces, m);
    if (!isDir(mdir)) continue;
    const source = sources[m] ?? "unknown";
    for (const sub of ["plugins", "external_plugins"]) {
      const subdir = join(mdir, sub);
      for (const p of safeReaddir(subdir)) {
        const pdir = join(subdir, p);
        if (isDir(pdir) && isPluginDir(pdir)) out.push(scanPlugin(pdir, p, m, source));
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
