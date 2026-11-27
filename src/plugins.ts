import { readFileSync, existsSync, statSync, readdirSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findSkillFiles } from "./discover.js";
import { buildRow, flatFindings } from "./manifest.js";
import { scanMcpConfig, scanInstruction, type Finding } from "./scan.js";
import { scanHooks, scanInlineHooks } from "./hooks.js";

/** Recursively collect *.md paths (relative to `dir`), never following symlinks
 *  (same DoS guard as the project walker). Bounded depth as a backstop. */
function findMarkdown(dir: string, depth = 0): string[] {
  if (depth > 12) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const abs = join(dir, name);
    let s;
    try {
      s = lstatSync(abs);
    } catch {
      continue;
    }
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) out.push(...findMarkdown(abs, depth + 1).map((p) => join(name, p)));
    else if (/\.md$/i.test(name)) out.push(name);
  }
  return out;
}

/**
 * Audit installed Claude Code plugins. A plugin is a bigger supply-chain surface than
 * a standalone skill — it bundles skills/commands/agents + an MCP config + hooks, from
 * a third-party marketplace, and runs with your agent.
 *
 * Ground truth is ~/.claude/plugins/installed_plugins.json (CC 2.1.332, version 2):
 * `plugins` is keyed "name@marketplace" → an array of install records, each with an
 * `installPath` under cache/<marketplace>/<plugin>/<version>/. We scan each installPath
 * (NOT the marketplaces/ catalog, which lists every available plugin), reusing our skill,
 * MCP, hook and dangerous-command detectors, and also read plugin.json's inline hooks /
 * mcpServers. Read-only: audits what's installed; never installs/removes.
 */

export interface PluginInfo {
  key: string; // name@marketplace
  name: string;
  marketplace: string;
  source: string; // "github:owner/repo" | "directory:/path" | "git:url" | "unknown"
  version: string;
  scopes: string[]; // user / project / local — every scope this installPath is recorded in
  projectPaths: string[]; // for project-scope records
  enabled: boolean; // from enabledPlugins in user/project settings
  installPath: string;
  skills: number;
  commands: number;
  agents: number;
  hasMcp: boolean;
  hasHooks: boolean;
  findings: Array<{ file: string; finding: Finding }>;
  errorCount: number;
  warnCount: number;
}

interface InstallRecord {
  scope?: string;
  installPath?: string;
  version?: string;
  projectPath?: string;
}

function pluginsBase(): string {
  return join(homedir(), ".claude", "plugins");
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function countMd(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => /\.md$/i.test(f)).length;
  } catch {
    return 0;
  }
}
function expandHome(p: string): string {
  return p.replace(/^~(?=[/\\]|$)/, homedir());
}
function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf("@");
  return i > 0 ? [key.slice(0, i), key.slice(i + 1)] : [key, ""];
}

function readInstalled(base: string): Record<string, InstallRecord[]> {
  const file = join(base, "installed_plugins.json");
  if (!existsSync(file)) return {}; // genuinely no plugins installed — fine
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // The list exists but can't be read — a security tool must NOT report "0 plugins"
    // (that reads as "nothing to audit"); surface it so the caller can fail.
    throw new Error("couldn't read the plugin list — installed_plugins.json is unreadable");
  }
  try {
    const j = JSON.parse(raw) as { plugins?: Record<string, InstallRecord[]> };
    return j?.plugins ?? {};
  } catch {
    throw new Error("couldn't read the plugin list — installed_plugins.json is not valid JSON");
  }
}

/** marketplace name → readable source, from known_marketplaces.json. */
function marketplaceSources(base: string): Record<string, string> {
  try {
    const km = JSON.parse(readFileSync(join(base, "known_marketplaces.json"), "utf8")) as Record<
      string,
      { source?: { source?: string; repo?: string; path?: string; url?: string } }
    >;
    const out: Record<string, string> = {};
    for (const [name, v] of Object.entries(km)) {
      const s = v?.source;
      out[name] =
        s?.source === "github" && s?.repo
          ? `github:${s.repo}`
          : s?.source === "directory" && s?.path
            ? `directory:${s.path}`
            : s?.source === "git" && (s?.url || s?.repo)
              ? `git:${s.url ?? s.repo}`
              : (s?.source ?? "unknown");
    }
    return out;
  } catch {
    return {};
  }
}

function addEnabled(settingsPath: string, set: Set<string>): void {
  try {
    const ep = (JSON.parse(readFileSync(settingsPath, "utf8")) as { enabledPlugins?: Record<string, unknown> })
      ?.enabledPlugins;
    if (ep && typeof ep === "object") for (const [k, v] of Object.entries(ep)) if (v) set.add(k);
  } catch {
    /* no/invalid settings — nothing enabled from here */
  }
}

/** Keys enabled in user settings + any project settings referenced by install records. */
function enabledKeys(records: Record<string, InstallRecord[]>): Set<string> {
  const set = new Set<string>();
  addEnabled(join(homedir(), ".claude", "settings.json"), set);
  for (const recs of Object.values(records)) {
    for (const r of recs) if (r.projectPath) addEnabled(join(r.projectPath, ".claude", "settings.json"), set);
  }
  return set;
}

/** Scan an mcpServers block (inline object, or a string path to a JSON file) for MCP
 *  risk AND dangerous commands in each server's command/args. */
function scanMcpServers(
  mcpServers: unknown,
  dir: string,
  name: string,
  label: string,
  findings: PluginInfo["findings"]
): void {
  let servers: unknown = mcpServers;
  let content: string | null = null;
  if (typeof mcpServers === "string") {
    const p = join(dir, mcpServers);
    if (!existsSync(p)) return;
    try {
      content = readFileSync(p, "utf8");
      const parsed = JSON.parse(content) as { mcpServers?: unknown };
      servers = parsed?.mcpServers ?? parsed;
    } catch {
      return;
    }
  }
  if (!servers || typeof servers !== "object") return;
  // scanMcpConfig covers MCP risk (pinning/secrets/injection) AND dangerous server
  // commands (bash -c 'curl|sh'), so the synthetic content is enough.
  const synthetic = content ?? JSON.stringify({ mcpServers: servers });
  for (const f of scanMcpConfig(label, synthetic)) findings.push({ file: `${name}/${label}`, finding: f });
}

function scanPluginAt(
  installPath: string,
  key: string,
  name: string,
  marketplace: string,
  source: string,
  version: string,
  scopes: string[],
  projectPaths: string[],
  enabled: boolean
): PluginInfo {
  const findings: PluginInfo["findings"] = [];

  // Bundled skills (reuse buildRow — also scans each skill's own bundle).
  const skillFiles = findSkillFiles(installPath).filter((r) => /(^|\/)skill\.md$/i.test(r));
  for (const rel of skillFiles) {
    const row = buildRow(join(installPath, rel), rel);
    for (const ff of flatFindings(row)) findings.push({ file: `${name}/${ff.file}`, finding: ff.finding });
  }

  // Bundled slash-commands and subagents (commands/*.md, agents/*.md) — instruction
  // surfaces Claude Code loads and obeys, scanned like project ones (prompt-injection,
  // hidden-unicode, embedded secrets). Previously skipped, so an injected plugin
  // command/agent reported nothing.
  for (const sub of ["commands", "agents"]) {
    const dir = join(installPath, sub);
    if (!existsSync(dir)) continue;
    for (const rel of findMarkdown(dir)) {
      const abs = join(dir, rel);
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      for (const f of scanInstruction(`${sub}/${rel}`, content)) {
        findings.push({ file: `${name}/${sub}/${rel}`, finding: f });
      }
    }
  }

  // Root .mcp.json.
  const mcp = join(installPath, ".mcp.json");
  const hasRootMcp = existsSync(mcp);
  if (hasRootMcp) {
    for (const f of scanMcpConfig(".mcp.json", readFileSync(mcp, "utf8"))) findings.push({ file: `${name}/.mcp.json`, finding: f });
  }

  // Hooks from hooks/hooks.json.
  const hasHooksFile = existsSync(join(installPath, "hooks", "hooks.json"));
  for (const f of scanHooks(installPath)) findings.push({ file: `${name}/hooks.json`, finding: f });

  // plugin.json may declare hooks / mcpServers inline (or point at a file).
  let inlineHooks = false;
  let inlineMcp = false;
  for (const pj of [join(installPath, "plugin.json"), join(installPath, ".claude-plugin", "plugin.json")]) {
    if (!existsSync(pj)) continue;
    try {
      const j = JSON.parse(readFileSync(pj, "utf8")) as { hooks?: unknown; mcpServers?: unknown };
      if (j?.hooks) {
        inlineHooks = true;
        for (const f of scanInlineHooks(j.hooks, installPath)) findings.push({ file: `${name}/plugin.json (hooks)`, finding: f });
      }
      if (j?.mcpServers) {
        inlineMcp = true;
        scanMcpServers(j.mcpServers, installPath, name, "plugin.json (mcpServers)", findings);
      }
    } catch {
      findings.push({
        file: `${name}/plugin.json`,
        finding: { severity: "warning", rule: "plugin-unparseable", message: "plugin.json is not valid JSON — can't fully audit it", suggestion: "fix the JSON" },
      });
    }
    break;
  }

  return {
    key,
    name,
    marketplace,
    source,
    version,
    scopes,
    projectPaths,
    enabled,
    installPath,
    skills: skillFiles.length,
    commands: countMd(join(installPath, "commands")),
    agents: countMd(join(installPath, "agents")),
    hasMcp: hasRootMcp || inlineMcp,
    hasHooks: hasHooksFile || inlineHooks,
    findings,
    errorCount: findings.filter((f) => f.finding.severity === "error").length,
    warnCount: findings.filter((f) => f.finding.severity === "warning").length,
  };
}

/** Discover + scan every installed plugin from installed_plugins.json. */
export function discoverPlugins(): PluginInfo[] {
  const base = pluginsBase();
  const records = readInstalled(base);
  const sources = marketplaceSources(base);
  const enabled = enabledKeys(records);

  const out: PluginInfo[] = [];
  for (const [key, recs] of Object.entries(records)) {
    if (!Array.isArray(recs) || recs.length === 0) continue;
    const [name, marketplace] = splitKey(key);
    // Dedupe by installPath (same path can appear as user + project), but keep all scopes.
    const byPath = new Map<string, InstallRecord[]>();
    for (const r of recs) {
      const ip = expandHome(r.installPath ?? "");
      if (!ip) continue;
      const list = byPath.get(ip) ?? [];
      list.push(r);
      byPath.set(ip, list);
    }
    for (const [installPath, group] of byPath) {
      if (!isDir(installPath)) continue; // stale / missing on disk
      const scopes = [...new Set(group.map((r) => r.scope).filter(Boolean))] as string[];
      const projectPaths = [...new Set(group.map((r) => r.projectPath).filter(Boolean))] as string[];
      out.push(
        scanPluginAt(
          installPath,
          key,
          name,
          marketplace,
          sources[marketplace] ?? "unknown",
          group[0].version ?? "",
          scopes,
          projectPaths,
          enabled.has(key)
        )
      );
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
