import { readFileSync, existsSync } from "node:fs";
import { join, dirname, basename, isAbsolute } from "node:path";
import { scanCode, scanAgentConfigFile, type Finding } from "./scan.js";
import { scanDangerous } from "./danger.js";

/** Dangerous-command scan for hook command/script text (keeps hook-* rule ids). */
const dangerousFindings = (text: string, where: string): Finding[] => scanDangerous(text, where, "hook");

/**
 * Config-risk analysis for Claude Code settings. Two surfaces:
 *   - a plugin's bundled hooks/hooks.json (see scanHooks)
 *   - a settings.json — project .claude/settings.json or ~/.claude/settings.json
 *     (see scanSettings), which carries more than hooks: apiKeyHelper, env,
 *     permissions, and plugin-marketplace keys.
 * The settings.json surface is the dangerous one: a repo you clone can ship a
 * .claude/settings.json whose PreToolUse hook (or apiKeyHelper, or env base-URL
 * redirect) runs the moment you use the agent in that directory — the
 * "rules-file backdoor" shape. We can't stop these running, but we can surface
 * (a) that they run and on what, and (b) dangerous values in the command, the
 * bundled script it invokes, the args array, an http endpoint, or the config keys.
 */


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
    message: `${label} is not valid JSON — can't audit it`,
    suggestion: "fix the JSON so its hooks and config can be reviewed",
  };
}

// Events that auto-run with no per-action approval: SessionStart/Setup at session
// start, UserPromptSubmit/UserPromptExpansion on every prompt. Once you trust the
// repo these fire automatically, so their command is worth reviewing before you do.
const SENSITIVE_EVENTS = new Set(["SessionStart", "Setup", "UserPromptSubmit", "UserPromptExpansion"]);

type HookEntry = { type?: string; command?: unknown; args?: unknown; url?: unknown };

/** The full shell text of a hook: its command plus any args. Dangerous payloads
 *  often live in args (e.g. {command:"bash", args:["-c","curl … | sh"]}). */
function hookCommandText(h: HookEntry): string {
  const parts: string[] = [];
  if (typeof h.command === "string") parts.push(h.command);
  if (Array.isArray(h.args)) for (const a of h.args) if (typeof a === "string") parts.push(a);
  return parts.join(" ");
}

/** An http hook posts the hook payload (prompts, tool inputs) to a URL. A remote,
 *  non-loopback endpoint is an exfiltration channel; localhost is a benign local server. */
function httpHookFindings(url: string, tag: string): Finding[] {
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?:[:/]|$)/i.test(url.trim())) return [];
  return [
    {
      severity: "warning",
      rule: "hook-http-endpoint",
      message: `hook ${tag} posts to an external URL: ${truncate(url)}`,
      suggestion: "this sends hook payloads (prompts, tool inputs) to a remote server on every event — confirm you trust it",
    },
  ];
}

/** Walk a parsed hooks map (`{ EventName: [{ matcher?, hooks: [{type,command,args,url}] }] }`),
 *  flag dangerous commands/args, the scripts they invoke, http endpoints, and sensitive
 *  events, and emit one transparency line listing the events that auto-run. */
function walkHooks(root: Record<string, unknown>, resolve: ScriptResolver): Finding[] {
  const findings: Finding[] = [];
  const events: string[] = [];
  const sensitive = new Set<string>();
  const scannedScripts = new Set<string>();

  for (const [event, matchers] of Object.entries(root)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers as Array<{ matcher?: string; hooks?: HookEntry[] }>) {
      const tag = `${event}${m?.matcher ? `(${m.matcher})` : ""}`;
      events.push(tag);
      if (SENSITIVE_EVENTS.has(event)) sensitive.add(event);
      for (const h of m?.hooks ?? []) {
        if (h?.type === "http" && typeof h.url === "string") {
          findings.push(...httpHookFindings(h.url, tag));
          continue;
        }
        const cmdText = hookCommandText(h);
        if (!cmdText) continue; // non-shell hook type (prompt/agent/mcp_tool) — nothing to scan
        findings.push(...dangerousFindings(cmdText, `hook ${tag} command`));

        const sc = resolve(cmdText);
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
  if (sensitive.size) {
    findings.push({
      severity: "warning",
      rule: "hook-sensitive-event",
      message: `hooks run on ${[...sensitive].join(", ")} — these auto-run at session start or on every prompt, with no per-action approval`,
      suggestion: "once you trust this repo these run automatically on those events — review the command above before trusting the folder",
    });
  }
  return findings;
}

function truncate(s: string, n = 90): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
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

/** Hook-risk analysis for `plugin.json.hooks` — an inline hooks map OR a string path
 *  to a hooks file relative to the plugin dir. (CC 2.1.332: plugins can declare hooks
 *  inline in plugin.json, not just in hooks/hooks.json.) */
export function scanInlineHooks(hooks: unknown, pluginDir: string): Finding[] {
  let root: unknown = hooks;
  if (typeof hooks === "string") {
    const p = join(pluginDir, hooks);
    if (!existsSync(p)) return [];
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      root = (parsed as { hooks?: unknown })?.hooks ?? parsed;
    } catch {
      return [unparseable(basename(p))];
    }
  }
  if (!root || typeof root !== "object") return [];
  return walkHooks(root as Record<string, unknown>, (cmd) => pluginScript(cmd, pluginDir));
}

// --- settings.json checks that remain in the tool ---
//
// Canonical config-key detection — apiKeyHelper, env *_BASE_URL redirect, defaultMode,
// permissions.allow / additionalDirectories, extraKnownMarketplaces — is owned by the
// ENGINE's agent-config-scanner (agent-* rules), invoked in scanSettings below. Only the
// two checks the pure/zero-fs engine can't host stay here: the env secret-scan (needs
// scanCode) and the enabledPlugins transparency line (info — the engine emits only
// error/warning).

/** Hardcoded secrets/tokens in the env block — not covered by the engine's config scan. */
function scanEnvSecrets(env: unknown): Finding[] {
  if (!env || typeof env !== "object") return [];
  const envText = Object.entries(env as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  if (!envText) return [];
  return scanCode("settings.env", envText, "shellscript").map((f) => ({ ...f, message: `env block: ${f.message}` }));
}

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?:[:/]|$)/i;

/** Risky env vars Claude Code exports into every tool/subprocess it runs. */
function scanEnvRisks(env: unknown): Finding[] {
  if (!env || typeof env !== "object") return [];
  const e = env as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof e[k] === "string" ? (e[k] as string) : undefined);
  const out: Finding[] = [];

  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) {
    const v = str(k);
    if (v && v.trim() && !LOOPBACK.test(v.trim())) {
      out.push({
        severity: "warning",
        rule: "settings-env-proxy",
        message: `env: ${k}=${v} routes all HTTP(S) traffic through a remote proxy — it can intercept or exfiltrate requests`,
        suggestion: "remove it unless you control this proxy (a loopback address is fine)",
      });
      break; // one finding is enough
    }
  }
  const nodeOpts = str("NODE_OPTIONS");
  if (nodeOpts && /(?:^|\s)--(require|import|loader|experimental-loader)\b/.test(nodeOpts)) {
    out.push({
      severity: "error",
      rule: "settings-env-node-options",
      message: `env: NODE_OPTIONS="${nodeOpts}" injects code into every Node process it spawns (--require/--import)`,
      suggestion: "remove the --require/--import/--loader directive",
    });
  }
  if (/^(0|false)$/i.test((str("NODE_TLS_REJECT_UNAUTHORIZED") ?? "").trim())) {
    out.push({
      severity: "warning",
      rule: "settings-env-tls-off",
      message: "env: NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate verification (man-in-the-middle risk)",
      suggestion: "remove it — don't disable certificate checking globally",
    });
  }
  return out;
}

/** Settings keys whose value is a shell command Claude Code runs automatically
 *  (statusLine refresh, AWS auth refresh, OTEL header helper). apiKeyHelper is already
 *  covered by the engine. Baseline warning for running a command; escalates to error
 *  if the command itself is dangerous (curl|sh, etc.). */
function scanCommandKeys(s: Record<string, unknown>): Finding[] {
  const sl = s.statusLine && typeof s.statusLine === "object" ? (s.statusLine as Record<string, unknown>).command : undefined;
  const keys: Array<[string, unknown]> = [
    ["statusLine.command", sl],
    ["awsAuthRefresh", s.awsAuthRefresh],
    ["otelHeadersHelper", s.otelHeadersHelper],
  ];
  const out: Finding[] = [];
  for (const [key, cmd] of keys) {
    if (typeof cmd !== "string" || !cmd.trim()) continue;
    out.push({
      severity: "warning",
      rule: "settings-command-key",
      message: `${key} runs a shell command automatically: ${cmd.length > 80 ? cmd.slice(0, 79) + "…" : cmd}`,
      suggestion: "this executes without the model's involvement — vet it",
    });
    out.push(...scanDangerous(cmd, key, "settings"));
  }
  return out;
}

/** Transparency: which plugins auto-load (info — below the engine's error/warning floor). */
function scanEnabledPlugins(s: Record<string, unknown>): Finding[] {
  const plugins = s.enabledPlugins;
  const plist = Array.isArray(plugins)
    ? plugins
    : plugins && typeof plugins === "object"
      ? Object.keys(plugins as object)
      : [];
  if (!plist.length) return [];
  return [
    {
      severity: "info",
      rule: "config-enabled-plugins",
      message: `auto-enables plugin(s): ${plist.slice(0, 8).join(", ")}${plist.length > 8 ? "…" : ""}`,
      suggestion: "these plugins load automatically — run `preflight plugins` to audit them",
    },
  ];
}

/** Config-risk analysis for a settings.json (project or user). Canonical config-key
 *  risk comes from the engine's agent-config scanner; this adds the deep hook analysis,
 *  env secret-scan, and enabledPlugins transparency. Read-only; the file is never changed. */
export function scanSettings(settingsPath: string): Finding[] {
  if (!existsSync(settingsPath)) return [];

  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [unparseable(basename(settingsPath))];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const s = parsed as Record<string, unknown>;
  const findings: Finding[] = [];

  // Engine (shared) agent-autonomy detection — canonical allow/mode/mcp rules, the
  // same source vet and the extension use. Suppress its shallow agent-auto-run-hook;
  // our deep hook scan below (args, http, scripts, sensitive events) supersedes it.
  for (const f of scanAgentConfigFile(settingsPath, raw)) {
    if (f.rule !== "agent-auto-run-hook") findings.push(f);
  }

  if (s.hooks && typeof s.hooks === "object") {
    const base = dirname(settingsPath);
    // $CLAUDE_PROJECT_DIR is the project root — the dir containing .claude.
    const projectDir = basename(base) === ".claude" ? dirname(base) : undefined;
    findings.push(...walkHooks(s.hooks as Record<string, unknown>, (cmd) => settingsScript(cmd, base, projectDir)));
  }
  findings.push(...scanEnvSecrets(s.env));
  findings.push(...scanEnvRisks(s.env));
  findings.push(...scanCommandKeys(s));
  findings.push(...scanEnabledPlugins(s));
  return findings;
}
