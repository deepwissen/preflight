import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scanCode, type Finding } from "./scan.js";

/**
 * Hook-risk analysis for a plugin's hooks/hooks.json. Hooks are the
 * highest-privilege plugin component — they run commands automatically on events
 * (PreToolUse, SessionStart, …) with no per-run approval. We can't stop them
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

/** A bundled script a hook command invokes via ${CLAUDE_PLUGIN_ROOT}/... */
function hookScript(cmd: string, pluginDir: string): { abs: string; rel: string; lang: string } | null {
  const m = /(?:\$\{?CLAUDE_PLUGIN_ROOT\}?\/)([\w./-]+\.(sh|bash|zsh|py|js|cjs|mjs|ts|rb|pl|ps1))/i.exec(cmd);
  if (!m) return null;
  return { abs: join(pluginDir, m[1]), rel: m[1], lang: EXT_LANG[m[2].toLowerCase()] ?? "shellscript" };
}

export function scanHooks(pluginDir: string): Finding[] {
  const hj = join(pluginDir, "hooks", "hooks.json");
  if (!existsSync(hj)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(hj, "utf8"));
  } catch {
    return [{ severity: "warning", rule: "hook-unparseable", message: "hooks.json is not valid JSON — can't audit it", suggestion: "fix the JSON so its hooks can be reviewed" }];
  }
  const root = (parsed as { hooks?: unknown })?.hooks ?? parsed;
  if (!root || typeof root !== "object") return [];

  const findings: Finding[] = [];
  const events: string[] = [];
  const scannedScripts = new Set<string>();

  for (const [event, matchers] of Object.entries(root as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers as Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>) {
      const tag = `${event}${m?.matcher ? `(${m.matcher})` : ""}`;
      events.push(tag);
      for (const h of m?.hooks ?? []) {
        if (h?.type !== "command" || typeof h.command !== "string") continue;
        findings.push(...dangerousFindings(h.command, `hook ${tag} command`));

        const sc = hookScript(h.command, pluginDir);
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
