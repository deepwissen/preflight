import { parseArgs } from "node:util";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import {
  buildManifest,
  buildRow,
  exitForReport,
  type FailOn,
  type ManifestReport,
} from "./manifest.js";
import { resolveSkill } from "./discover.js";
import {
  renderManifest,
  renderJson,
  renderCheck,
  renderCheckJson,
  renderList,
} from "./render.js";
import { renderManifestSarif } from "./sarif.js";
import { stageSource, planInstall, installItem, removeSkill } from "./install.js";

const FAIL_ON: readonly string[] = ["error", "warning", "any"];

const VERSION = "0.1.0"; // keep in sync with package.json

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
  preflight add <source>      Stage a skill (local path or owner/repo), scan it,
                              and install it only if it's clean (or you --force).
  preflight remove <name>     Move an installed skill to .preflight-trash/ (needs --yes).

Options:
  --json                      Machine-readable output
  --sarif                     SARIF 2.1.0 → GitHub code scanning annotations
  --fail-on <level>           Exit non-zero on: error (default) | warning | any
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

  const root = resolve(positionals[0] ?? ".");
  if (!existsSync(root)) {
    err(`preflight: no such path: ${root}\n`);
    return 2;
  }

  const report = buildManifest(root);
  out(
    (values.sarif
      ? renderManifestSarif(report)
      : values.json
        ? renderJson(report)
        : renderManifest(report)) + "\n"
  );
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
  const res = resolveSkill(resolve("."), arg);
  if ("error" in res) {
    err(`preflight: ${res.error}\n`);
    for (const c of res.candidates ?? []) err(`    - ${c}\n`);
    return 2;
  }

  const row = buildRow(res.absPath, res.displayPath);
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
  let positionals: string[];
  try {
    positionals = parseArgs({ args: argv, allowPositionals: true, options: {} }).positionals;
  } catch (e) {
    err(`preflight: ${(e as Error).message}\n`);
    return 2;
  }
  const root = resolve(positionals[0] ?? ".");
  if (!existsSync(root)) {
    err(`preflight: no such path: ${root}\n`);
    return 2;
  }
  out(renderList(buildManifest(root)) + "\n");
  return 0;
}

function runAdd(argv: string[], out: (s: string) => void, err: (s: string) => void): number {
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

  try {
    const root = resolve(".");
    const plan = planInstall(staging.dir, root);
    if (plan.length === 0) {
      err(`preflight: no skills (SKILL.md) found in "${src}"\n`);
      return 2;
    }

    const report: ManifestReport = {
      root: src,
      rows: plan.map((p) => p.row),
      alwaysTotal: plan.reduce((n, p) => n + p.row.alwaysTokens, 0),
      onDemandTotal: plan.reduce((n, p) => n + p.row.onDemandTokens, 0),
    };
    out(renderManifest(report) + "\n");

    if (exitForReport(report, failOn as FailOn) === 1 && !values.force) {
      err(
        `\npreflight: blocked — findings at/above "${failOn}". Review above; re-run with --force to install anyway.\n`
      );
      return 1;
    }
    if (values["dry-run"]) {
      out("\ndry run — nothing installed.\n");
      return 0;
    }

    const clash = plan.filter((p) => p.exists);
    if (clash.length && !values.overwrite) {
      err(`preflight: already installed: ${clash.map((p) => p.name).join(", ")} (use --overwrite)\n`);
      return 1;
    }
    for (const item of plan) installItem(item, { overwrite: Boolean(values.overwrite) });
    out(
      `\ninstalled ${plan.length} skill(s) into .claude/skills/: ${plan
        .map((p) => p.name)
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
      options: { yes: { type: "boolean" } },
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
  const res = removeSkill(resolve("."), name, { yes: Boolean(values.yes) });
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

export function run(
  argv: string[],
  out: (s: string) => void = (s) => void process.stdout.write(s),
  err: (s: string) => void = (s) => void process.stderr.write(s)
): number {
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
  err(`preflight: unknown command "${sub}" (try: preflight --help)\n`);
  return 2;
}
