#!/usr/bin/env node
// Engine floor-check gate.
//
// Verifies that every VALUE symbol this package imports from the shared engine
// (@deepwissen/preflight-core) exists in the MINIMUM engine version its declared
// dependency range allows. A floor set too low lets a stale/in-range engine resolve
// at runtime that lacks a newer export — the "does not provide an export named X"
// crash that bit us (auditIgnoreCoverage) when the floor was ^0.1.6 but the code
// imported a symbol added in 0.1.12.
//
// The lockfile passing is NOT enough: it pins a version at/above the floor, while a
// user's fresh/stale resolve can land on the floor MINIMUM. So we check the minimum.
//
// Modes:
//   (default)   strict: fetch the floor-minimum PUBLISHED engine and check against it.
//   --local     check against the engine currently installed in node_modules (offline).
//   --range R   override the declared range (for testing / demos).
//
// Exit: 0 all imports satisfied · 1 missing export(s) / floor too low · 2 setup error.

import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

export const ENGINE = "@deepwissen/preflight-core";

/** The lowest version a dependency range admits — the first x.y.z in the range. */
export function minVersionFromRange(range) {
  const m = /(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?/.exec(String(range).trim());
  if (!m) throw new Error(`cannot derive a minimum version from range "${range}"`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/** Named VALUE imports from the engine in one source file (type-only imports — the
 *  whole `import type {…}` statement and inline `type X` specifiers — are erased at
 *  runtime and so can never cause the crash; they're excluded). */
export function extractCoreValueImports(source, engine = ENGINE) {
  const esc = engine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${esc}["']`, "g");
  const names = new Set();
  let m;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) continue; // `import type { … }` — type-only
    for (let spec of m[2].split(",")) {
      spec = spec.trim();
      if (!spec || spec.startsWith("type ")) continue; // inline `type X` specifier
      const name = spec.split(/\s+as\s+/)[0].trim(); // imported name, before any alias
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** Imports this package's declared range cannot guarantee — missing from `exports`. */
export function missingImports(imports, exports) {
  const have = new Set(exports);
  return imports.filter((n) => !have.has(n));
}

function tsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.(ts|tsx|mts|cts)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p);
  }
  return out;
}

function collectImports(srcDir) {
  const names = new Set();
  for (const f of tsFiles(srcDir)) {
    for (const n of extractCoreValueImports(readFileSync(f, "utf8"))) names.add(n);
  }
  return [...names].sort();
}

async function moduleExports(indexPath) {
  return Object.keys(await import(pathToFileURL(indexPath).href));
}

/** Runtime exports of the installed engine (offline). */
function installedIndex(cwd) {
  return join(cwd, "node_modules", ...ENGINE.split("/"), "dist", "index.js");
}

/** Runtime exports of a published engine version (fetched via npm pack). */
async function floorMinExports(minVersion) {
  const tmp = mkdtempSync(join(tmpdir(), "floor-"));
  try {
    execFileSync("npm", ["pack", `${ENGINE}@${minVersion}`, "--pack-destination", tmp, "--silent"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("npm pack produced no tarball");
    execFileSync("tar", ["-xzf", join(tmp, tgz), "-C", tmp]);
    return await moduleExports(join(tmp, "package", "dist", "index.js"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(argv) {
  const local = argv.includes("--local");
  const ri = argv.indexOf("--range");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const deps = { ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.dependencies };
  const declared = ri >= 0 ? argv[ri + 1] : deps[ENGINE];
  if (!declared) {
    console.error(`${pkg.name}: no ${ENGINE} dependency declared — nothing to check`);
    return 2;
  }

  const imports = collectImports("src");
  if (imports.length === 0) {
    console.log(`✓ ${pkg.name}: no value imports from ${ENGINE}`);
    return 0;
  }

  let exports, against;
  if (local) {
    against = "the installed engine (node_modules)";
    try {
      exports = await moduleExports(installedIndex(process.cwd()));
    } catch (e) {
      console.error(`✗ ${pkg.name}: cannot load installed ${ENGINE} — run npm install first`);
      console.error(`  ${String(e.message || e).split("\n")[0]}`);
      return 2;
    }
  } else {
    const min = minVersionFromRange(declared);
    against = `${ENGINE}@${min} (floor minimum of "${declared}")`;
    try {
      exports = await floorMinExports(min);
    } catch (e) {
      console.error(`✗ ${pkg.name}: could not fetch ${ENGINE}@${min} to verify the floor.`);
      console.error(`  ${String(e.message || e).split("\n")[0]}`);
      console.error(`  If ${min} is not published yet, publish the engine before releasing this package.`);
      return 2;
    }
  }

  const missing = missingImports(imports, exports);
  if (missing.length) {
    console.error(`✗ ${pkg.name}: ${missing.length} import(s) NOT provided by ${against}:`);
    for (const n of missing) console.error(`    - ${n}`);
    console.error(`\n  The floor is too low. Raise the ${ENGINE} range to the version that`);
    console.error(`  first exported these symbols, then relock.`);
    return 1;
  }
  console.log(`✓ ${pkg.name}: all ${imports.length} value import(s) satisfied by ${against}.`);
  return 0;
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(2);
    });
}
