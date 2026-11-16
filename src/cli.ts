import { parseArgs } from "node:util";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { buildManifest } from "./manifest.js";
import { renderManifest, renderJson } from "./render.js";

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
  preflight manifest [path]   Inventory the skills your agent carries — scope,
                              static token footprint, and a scan of each.

Options:
  --json                      Machine-readable output
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
      options: { json: { type: "boolean" } },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    err(`preflight: ${(e as Error).message}\n`);
    return 2;
  }

  const root = resolve(positionals[0] ?? ".");
  if (!existsSync(root)) {
    err(`preflight: no such path: ${root}\n`);
    return 2;
  }

  const report = buildManifest(root);
  out((values.json ? renderJson(report) : renderManifest(report)) + "\n");
  // Inventory is informational; surface a nonzero exit only when a skill has an
  // error-level finding, so it can double as a lightweight gate in CI.
  return report.rows.some((r) => r.errorCount > 0) ? 1 : 0;
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
  if (sub === "manifest") return runManifest(argv.slice(1), out, err);
  err(`preflight: unknown command "${sub}" (try: preflight --help)\n`);
  return 2;
}
