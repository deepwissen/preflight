import { readFileSync, existsSync } from "node:fs";
import { join, dirname, basename, isAbsolute } from "node:path";
import { scanCode, type Finding } from "./scan.js";

/**
 * Hook-risk analysis. Hooks are the highest-privilege Claude Code component —
 * they run commands automatically on events (PreToolUse, SessionStart, …) with no
 * per-run approval. They live in two places: bundled in a plugin
 * (hooks/hooks.json, see scanHooks) and configured in a settings.json — project
 * .claude/settings.json or ~/.claude/settings.json (see scanSettingsHooks). The
 * settings.json surface is the more dangerous one: a repo you clone can ship a
 * .claude/settings.json whose PreToolUse command runs the moment you use the
 * agent in that directory (the "rules-file backdoor" shape). We can't stop hooks
 * running, but we can surface (a) that they run and on what, and (b) dangerous
 * command patterns in the inline command or the bundled script it invokes.
 */

const DANGEROUS: Array<{ re: RegExp; rule: string; severity: Finding["severity"]; what: string }> = [
  {
    re: /\b(?:curl|wget|fetch)\b[^|&;]*\|\s*(?:sh|bash|zsh|python3?|node|deno)\b/i,
    rule: "hook-fetch-execute",
    severity: "error",
    what: "fetches a remote script and pipes it to a shell (remote code execution)",
  },
  {
    re: /\beval\b[^;]*\$\((?:curl|wget)\b/i,
    rule: "hook-fetch-execute",
    severity: "error",
    what: "evals the output of a remote fetch (remote code execution)",
  },
  {
    re: /\bbase64\s+(?:-d|--decode|-D)\b[^|]*\|\s*(?:sh|bash|zsh|python3?|node)\b/i,
    rule: "hook-obfuscated-exec",
    severity: "error",
    what: "decodes base64 and pipes it to a shell (obfuscated execution)",
  },
  {
    re: /(?:~\/\.ssh\/|\bid_rsa\b|\bid_ed25519\b|~\/\.aws\/credentials|\.pem\b)/i,
    rule: "hook-credential-access",
    severity: "warning",
    what: "touches credential files (SSH / AWS keys)",
  },
  {
    re: /\brm\s+-[rf]{1,2}\s+(?:\/(?!tmp\b)|~\/|\$HOME\b)/i,
    rule: "hook-destructive",
    severity: "error",
    what: "runs a destructive rm -rf on a home/root path",
  },
];

function dangerousFindings(text: string, where: string): Finding[] {
  const out: Finding[] = [];
  for (const d of DANGEROUS) {
    if (d.re.test(text)) {
      out.push({
        severity: d.severity,
        rule: d.rule,
        message: `${where}: ${d.what}`,
        suggestion: "this runs automatically on the event — remove the dangerous command or vet the remote source",
      });
    }
  }
  return out;
}

const EXT_LANG: Record<string, string> = {
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", py: "python",
  js: "javascript", cjs: "javascript", mjs: "javascript", ts: "typescript",
  rb: "ruby", pl: "perl", ps1: "powershell",
};

type ScriptRef = { abs: string; rel: string; lang: string };
type ScriptResolver = (cmd: string) => ScriptRef | null;

/** A bundled script a plugin hook invokes via ${CLAUDE_PLUGIN_ROOT}/... */
function pluginScript(cmd: string, pluginDir: string): ScriptRef | null {
  const m = /(?:\$\{?CLAUDE_PLUGIN_ROOT\}?\/)([\w./-]+\.(sh|bash|zsh|py|js|cjs|mjs|ts|rb|pl|ps1))/i.exec(cmd);
  if (!m) return null;
  return { abs: join(pluginDir, m[1]), rel: m[1], lang: EXT_LANG[m[2].toLowerCase()] ?? "shellscript" };
}

/** A script a settings.json hook invokes — absolute, relative to the settings dir,
 *  or under $CLAUDE_PROJECT_DIR (the project root, not the .claude dir). Conservative:
 *  a single literal script-path token. Harmless if it mis-resolves — the caller only
 *  scans it when the file exists. */
function settingsScript(cmd: string, baseDir: string, projectDir?: string): ScriptRef | null {
  const m = /(\$\{?CLAUDE_PROJECT_DIR\}?\/)?((?:\.?\.?\/)?[\w./-]+\.(sh|bash|zsh|py|js|cjs|mjs|ts|rb|pl|ps1))\b/i.exec(cmd);
  if (!m) return null;
  const usedProjectDir = Boolean(m[1]);
  const rel = m[2];
  let abs: string;
  if (isAbsolute(rel)) abs = rel;
  else if (usedProjectDir) {
    if (!projectDir) return null; // $CLAUDE_PROJECT_DIR unknown (e.g. user-level settings)
    abs = join(projectDir, rel);
  } else abs = join(baseDir, rel);
  return { abs, rel, lang: EXT_LANG[m[3].toLowerCase()] ?? "shellscript" };
}

function unparseable(label: string): Finding {
  return {
    severity: "warning",
    rule: "hook-unparseable",
    message: `${label} is not valid JSON — can't audit its hooks`,
    suggestion: "fix the JSON so its hooks can be reviewed",
  };
}

/** Walk a parsed hooks map (`{ EventName: [{ matcher?, hooks: [{type,command}] }] }`),
 *  flag dangerous commands and the scripts they invoke, and emit one transparency
 *  line listing the events that auto-run. `resolve` finds a bundled script per surface. */
function walkHooks(root: Record<string, unknown>, resolve: ScriptResolver): Finding[] {
  const findings: Finding[] = [];
  const events: string[] = [];
  const scannedScripts = new Set<string>();

  for (const [event, matchers] of Object.entries(root)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers as Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>) {
      const tag = `${event}${m?.matcher ? `(${m.matcher})` : ""}`;
      events.push(tag);
      for (const h of m?.hooks ?? []) {
        if (h?.type !== "command" || typeof h.command !== "string") continue;
        findings.push(...dangerousFindings(h.command, `hook ${tag} command`));

        const sc = resolve(h.command);
        if (sc && !scannedScripts.has(sc.abs) && existsSync(sc.abs)) {
          scannedScripts.add(sc.abs);
          let content = "";
          try {
            content = readFileSync(sc.abs, "utf8");
          } catch {
            continue;
          }
          findings.push(...dangerousFindings(content, `hook ${tag} script ${sc.rel}`));
          for (const f of scanCode(sc.rel, content, sc.lang)) {
            findings.push({ ...f, message: `hook ${tag} script ${sc.rel}: ${f.message}` });
          }
        }
      }
    }
  }

  if (events.length) {
    findings.unshift({
      severity: "info",
      rule: "hook-auto-run",
      message: `runs hooks automatically on: ${[...new Set(events)].join(", ")}`,
      suggestion: "these commands run without approval on those events — know what they do",
    });
  }
  return findings;
}

/** Hook-risk analysis for a plugin's hooks/hooks.json. */
export function scanHooks(pluginDir: string): Finding[] {
  const hj = join(pluginDir, "hooks", "hooks.json");
  if (!existsSync(hj)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(hj, "utf8"));
  } catch {
    return [unparseable("hooks.json")];
  }
  const root = (parsed as { hooks?: unknown })?.hooks ?? parsed;
  if (!root || typeof root !== "object") return [];
  return walkHooks(root as Record<string, unknown>, (cmd) => pluginScript(cmd, pluginDir));
}

/** Hook-risk analysis for hooks configured in a settings.json (project or user).
 *  Only the `hooks` block is read — the rest of the file is ignored. */
export function scanSettingsHooks(settingsPath: string): Finding[] {
  if (!existsSync(settingsPath)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return [unparseable(basename(settingsPath))];
  }
  const root = (parsed as { hooks?: unknown })?.hooks;
  if (!root || typeof root !== "object") return [];
  const base = dirname(settingsPath);
  // $CLAUDE_PROJECT_DIR is the project root — the dir containing .claude.
  const projectDir = basename(base) === ".claude" ? dirname(base) : undefined;
  return walkHooks(root as Record<string, unknown>, (cmd) => settingsScript(cmd, base, projectDir));
}
