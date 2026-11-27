import { relative } from "node:path";

/** Normalize any path to forward slashes (handles Windows `\` and mixed separators). */
export function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

/**
 * path.relative(), but ALWAYS forward-slash separated. The rest of the codebase treats a
 * repo-relative path as POSIX — `split("/").pop()` for exact file-name checks (.env,
 * Makefile, package.json, .mcp.json), skill-name conflict detection, and SARIF URIs
 * (which GitHub code scanning can't map if they contain backslashes). On Windows
 * path.relative returns `\`-separated, so normalize it here, once, at the boundary.
 */
export function relPosix(from: string, to: string): string {
  return toPosix(relative(from, to));
}
