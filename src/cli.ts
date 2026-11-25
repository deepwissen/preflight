import { parseArgs } from "node:util";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  buildScopes,
  buildRow,
  exitForReport,
  type FailOn,
  type ManifestReport,
} from "./manifest.js";
import {
  projectScope,
  userScope,
  scopeSkillNames,
  shadowNotices,
  type Scope,
} from "./scopes.js";
import { skillName } from "./collisions.js";
import { resolveSkill, type Resolved } from "./discover.js";
import {
  renderManifest,
  renderJson,
  renderCheck,
  renderCheckJson,
  renderList,
  renderPickList,
  renderPlugins,
} from "./render.js";
import { renderManifestSarif } from "./sarif.js";
import { discoverPlugins } from "./plugins.js";
import {
  stageSource,
  planInstall,
  installItem,
  removeSkill,
  parseSelection,
  selectByNames,
  type InstallItem,
} from "./install.js";

const FAIL_ON: readonly string[] = ["error", "warning", "any"];

/** Shadowing + hidden-scope hints for a single-scope view (not --all). */
function crossScopeNotices(
  flags: { global?: unknown; all?: unknown },
  projectRoot: string,
  report: ManifestReport,
  command: string
): string[] {
  if (flags.all) return [];
  const shown = report.rows.map((r) => skillName(r).toLowerCase());
  const other = scopeSkillNames(flags.global ? projectScope(projectRoot) : userScope());
  return shadowNotices({ shown, other, global: Boolean(flags.global), command });
}

/** Scopes to act on, honoring --global / --all and an optional explicit project path. */
function scopesFromFlags(
  flags: { global?: unknown; all?: unknown },
  projectRoot: string
): Scope[] {
  if (flags.all) return [projectScope(projectRoot), userScope()];
  if (flags.global) return [userScope()];
  return [projectScope(projectRoot)];
}

const VERSION = "0.3.0"; // keep in sync with package.json

/** Read one line from stdin (interactive skill selection). */
function promptLine(question: string): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      res(answer);
    });
  });
}

/** Resolve the @deepwissen/preflight-core version actually in use, for --version. */
function engineVersion(): string | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const pkg = join(dir, "node_modules", "@deepwissen", "preflight-core", "package.json");
      if (existsSync(pkg)) {
        const v = JSON.parse(readFileSync(pkg, "utf8")).version;
        return typeof v === "string" ? v : null;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

const HELP = `preflight — get your AI agent flight-ready.

Usage:
  preflight list [path]       Compact list of the skills your agent carries.
  preflight manifest [path]   Full inventory — scope, token footprint, scan of each.
  preflight check <skill>     Drill into one skill (by name or path): full scope,
                              footprint, and every finding with its fix.
  preflight add <source>      Stage skills (local path or owner/repo), scan them,
                              and choose which to install (not the whole repo).
                              Picks interactively, or: --only <names> / --pick <nums>.
  preflight remove <name>     Move an installed skill to .preflight-trash/ (needs --yes).
  preflight plugins           Audit installed plugins (~/.claude/plugins): source,
                              what each bundles, and a scan of its skills + MCP config.

Scope (list/manifest/check/add/remove):
  (default)                   project skills — ./.claude/skills
  --global                    personal skills — ~/.claude/skills
  --all                       (list/manifest) both, with a WHERE column

Options:
  --json                      Machine-readable output
  --sarif                     SARIF 2.1.0 → GitHub code scanning annotations
  --fail-on <level>           Exit non-zero on: error (default) | warning | any
  --only <names>              (add) install only these skills (comma-separated)
  --pick <nums>               (add) install these by number: 1,4,6 / 1-3 / all
  --force                     (add) install despite findings
  --overwrite                 (add) replace a skill that's already installed
  --dry-run                   (add) scan and report, install nothing
  --yes                       (remove) actually move the skill to trash
  -v, --version               Print version
  -h, --help                  Print help

Scope is what each skill DECLARES; a scan finds known-bad patterns but never
certifies a skill safe. All analysis is local — nothing is sent anywhere.`;

function runManifest(argv: string[], out: (s: string) => void, err: (s: string) => void): number {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        sarif: { type: "boolean" },
        global: { type: "boolean" },
        all: { type: "boolean" },
        "fail-on": { type: "string", default: "error" },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    err(`preflight: ${(e as Error).message}\n`);
    return 2;
  }

  const failOn = String(values["fail-on"]);
  if (!FAIL_ON.includes(failOn)) {
    err(`preflight: --fail-on must be one of ${FAIL_ON.join(", ")}\n`);
    return 2;
  }

  const projectRoot = resolve(positionals[0] ?? ".");
  if (!values.global && !existsSync(projectRoot)) {
    err(`preflight: no such path: ${projectRoot}\n`);
    return 2;
  }

  const report = buildScopes(scopesFromFlags(values, projectRoot));
  if (values.sarif) {
    out(renderManifestSarif(report) + "\n");
  } else if (values.json) {
    out(renderJson(report) + "\n");
  } else {
    out(renderManifest(report) + "\n");
    const notices = crossScopeNotices(values, projectRoot, report, "manifest");
    if (notices.length) out(notices.join("\n") + "\n");
  }
  return exitForReport(report, failOn as FailOn);
}

function runCheck(argv: string[], out: (s: string) => void, err: (s: string) => void): number {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        sarif: { type: "boolean" },
        global: { type: "boolean" },
        all: { type: "boolean" },
        "fail-on": { type: "string", default: "error" },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    err(`preflight: ${(e as Error).message}\n`);
    return 2;
  }

  const failOn = String(values["fail-on"]);
  if (!FAIL_ON.includes(failOn)) {
    err(`preflight: --fail-on must be one of ${FAIL_ON.join(", ")}\n`);
    return 2;
  }

  const arg = positionals[0];
  if (!arg) {
    err("preflight check: name a skill — preflight check <name|path>\n");
    return 2;
  }

  let resolved: Resolved | null = null;
  let lastErr: { error: string; candidates?: string[] } | null = null;
  for (const s of scopesFromFlags(values, resolve("."))) {
    const r = resolveSkill(s.scanRoot, arg, s.skip);
    if ("error" in r) lastErr = r;
    else {
      resolved = r;
      break;
    }
  }
  if (!resolved) {
    err(`preflight: ${lastErr?.error ?? `no skill matching "${arg}"`}\n`);
    for (const c of lastErr?.candidates ?? []) err(`    - ${c}\n`);
    return 2;
  }

  const row = buildRow(resolved.absPath, resolved.displayPath);
  const report: ManifestReport = {
    root: ".",
    rows: [row],
    alwaysTotal: row.alwaysTokens,
    onDemandTotal: row.onDemandTokens,
  };
  out(
    (values.sarif
      ? renderManifestSarif(report)
      : values.json
        ? renderCheckJson(row)
        : renderCheck(row)) + "\n"
  );
  return exitForReport(report, failOn as FailOn);
}

function runList(argv: string[], out: (s: string) => void, err: (s: string) => void): number {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { global: { type: "boolean" }, all: { type: "boolean" } },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    err(`preflight: ${(e as Error).message}\n`);
    return 2;
  }
  const projectRoot = resolve(positionals[0] ?? ".");
  if (!values.global && !existsSync(projectRoot)) {
    err(`preflight: no such path: ${projectRoot}\n`);
    return 2;
  }
  const report = buildScopes(scopesFromFlags(values, projectRoot));
  out(renderList(report) + "\n");
  const notices = crossScopeNotices(values, projectRoot, report, "list");
  if (notices.length) out(notices.join("\n") + "\n");
  return 0;
}

async function runAdd(
  argv: string[],
  out: (s: string) => void,
  err: (s: string) => void
): Promise<number> {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        force: { type: "boolean" },
        overwrite: { type: "boolean" },
        "dry-run": { type: "boolean" },
        global: { type: "boolean" },
        only: { type: "string" },
        pick: { type: "string" },
        "fail-on": { type: "string", default: "warning" },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    err(`preflight: ${(e as Error).message}\n`);
    return 2;
  }

  const failOn = String(values["fail-on"]);
  if (!FAIL_ON.includes(failOn)) {
    err(`preflight: --fail-on must be one of ${FAIL_ON.join(", ")}\n`);
    return 2;
  }
  if (values.only !== undefined && values.pick !== undefined) {
    err("preflight add: use --only or --pick, not both\n");
    return 2;
  }
  const src = positionals[0];
  if (!src) {
    err("preflight add: name a source — preflight add <path|owner/repo>\n");
    return 2;
  }

  let staging;
  try {
    staging = stageSource(src);
  } catch (e) {
    err(`preflight: could not stage "${src}": ${(e as Error).message.split("\n")[0]}\n`);
    return 2;
  }

  const target = values.global ? userScope() : projectScope();
  try {
    const items = planInstall(staging.dir, target.skillsDir);
    if (items.length === 0) {
      err(`preflight: no skills (SKILL.md) found in "${src}"\n`);
      return 2;
    }

    // --- choose which skills to install (not the whole repo) ---
    let selected: InstallItem[];
    if (values.only !== undefined) {
      const names = String(values.only).split(",").map((s) => s.trim()).filter(Boolean);
      const r = selectByNames(items, names);
      if (r.notFound.length) {
        err(`preflight: not found in "${src}": ${r.notFound.join(", ")}\n`);
        out(renderPickList(items, src) + "\n");
        return 2;
      }
      selected = r.selected;
    } else if (values.pick !== undefined) {
      const r = parseSelection(String(values.pick), items.length);
      if ("error" in r) {
        err(`preflight: ${r.error}\n`);
        return 2;
      }
      selected = r.indices.map((i) => items[i]);
    } else if (items.length === 1) {
      selected = items;
    } else {
      out(renderPickList(items, src) + "\n");
      if (process.stdin.isTTY) {
        const answer = await promptLine("\nInstall which? (e.g. 1,4,6 or 1-3 · all · none): ");
        const r = parseSelection(answer, items.length);
        if ("error" in r) {
          err(`preflight: ${r.error}\n`);
          return 2;
        }
        selected = r.indices.map((i) => items[i]);
      } else {
        out("\nChoose skills to install:  --pick 1,4,6  (or --pick all)  ·  --only <names>\n");
        return 0;
      }
    }

    if (selected.length === 0) {
      out("nothing selected — nothing installed.\n");
      return 0;
    }

    // --- gate the chosen skills, then install ---
    const report: ManifestReport = {
      root: src,
      rows: selected.map((s) => s.row),
      alwaysTotal: selected.reduce((n, s) => n + s.row.alwaysTokens, 0),
      onDemandTotal: selected.reduce((n, s) => n + s.row.onDemandTokens, 0),
    };
    if (exitForReport(report, failOn as FailOn) === 1 && !values.force) {
      const bad = selected.filter((s) => s.row.errorCount || s.row.warnCount).map((s) => s.name);
      err(
        `\npreflight: blocked — ${bad.join(", ")} ha${bad.length > 1 ? "ve" : "s"} findings at/above "${failOn}". Re-run with --force to install anyway.\n`
      );
      return 1;
    }
    if (values["dry-run"]) {
      out(`\ndry run — would install ${selected.length}: ${selected.map((s) => s.name).join(", ")}\n`);
      return 0;
    }

    const clash = selected.filter((s) => s.exists);
    if (clash.length && !values.overwrite) {
      err(`preflight: already installed: ${clash.map((s) => s.name).join(", ")} (use --overwrite)\n`);
      return 1;
    }
    for (const item of selected) installItem(item, { overwrite: Boolean(values.overwrite) });
    out(
      `\ninstalled ${selected.length} skill(s) into ${target.name} scope (${target.skillsDir}): ${selected
        .map((s) => s.name)
        .join(", ")}\n`
    );
    return 0;
  } finally {
    staging.cleanup();
  }
}

function runRemove(argv: string[], out: (s: string) => void, err: (s: string) => void): number {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { yes: { type: "boolean" }, global: { type: "boolean" } },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    err(`preflight: ${(e as Error).message}\n`);
    return 2;
  }
  const name = positionals[0];
  if (!name) {
    err("preflight remove: name a skill — preflight remove <name>\n");
    return 2;
  }
  const target = values.global ? userScope() : projectScope();
  const res = removeSkill(target.scanRoot, name, { yes: Boolean(values.yes), skip: target.skip });
  if ("error" in res) {
    err(`preflight: ${res.error}\n`);
    return 2;
  }
  if ("wouldRemove" in res) {
    out(
      `would remove ${res.wouldRemove} (${res.files} file(s)). Re-run with --yes to move it to .preflight-trash/.\n`
    );
    return 2;
  }
  out(`removed ${res.removed} → .preflight-trash/\n`);
  return 0;
}

function runPlugins(argv: string[], out: (s: string) => void, err: (s: string) => void): number {
  let values: Record<string, unknown>;
  try {
    values = parseArgs({ args: argv, allowPositionals: false, options: { json: { type: "boolean" } } }).values;
  } catch (e) {
    err(`preflight: ${(e as Error).message}\n`);
    return 2;
  }
  const plugins = discoverPlugins();
  out((values.json ? JSON.stringify({ plugins }, null, 2) : renderPlugins(plugins)) + "\n");
  // Advisory audit: exit 1 if any plugin has an error-level finding.
  return plugins.some((p) => p.errorCount > 0) ? 1 : 0;
}

export async function run(
  argv: string[],
  out: (s: string) => void = (s) => void process.stdout.write(s),
  err: (s: string) => void = (s) => void process.stderr.write(s)
): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === "-h" || sub === "--help") {
    out(HELP + "\n");
    return 0;
  }
  if (sub === "-v" || sub === "--version") {
    const engine = engineVersion();
    out(VERSION + (engine ? ` (engine @deepwissen/preflight-core ${engine})` : "") + "\n");
    return 0;
  }
  if (sub === "list") return runList(argv.slice(1), out, err);
  if (sub === "manifest") return runManifest(argv.slice(1), out, err);
  if (sub === "check") return runCheck(argv.slice(1), out, err);
  if (sub === "add") return runAdd(argv.slice(1), out, err);
  if (sub === "remove") return runRemove(argv.slice(1), out, err);
  if (sub === "plugins") return runPlugins(argv.slice(1), out, err);
  err(`preflight: unknown command "${sub}" (try: preflight --help)\n`);
  return 2;
}
