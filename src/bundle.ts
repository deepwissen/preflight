import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { scanCode, scanMcpConfig, looksMcpConfig, type Finding } from "./scan.js";

// Executable/script file types a skill may ship alongside its SKILL.md. The agent
// can be told to run these, so they're code the skill carries — worth scanning.
const SCRIPT_LANG: Record<string, string> = {
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".py": "python",
  ".rb": "ruby",
  ".pl": "perl",
  ".js": "javascript",
  ".cjs": "javascript",
  ".mjs": "javascript",
  ".ts": "typescript",
  ".ps1": "powershell",
};

const MAX_BYTES = 256 * 1024; // don't read very large files into memory
const MAX_FILES = 200; // bound the walk

export interface BundledScript {
  path: string; // relative to the skill directory
  language: string;
  bytes: number;
  findings: Finding[];
}

export interface Bundle {
  scripts: BundledScript[];
  otherFiles: number; // non-script files that ship with the skill
}

const EMPTY: Bundle = { scripts: [], otherFiles: 0 };

/**
 * Enumerate the files a skill actually ships — ground truth, vs. the content-only
 * `referencedScripts` heuristic (which only parses what the SKILL.md *mentions*).
 * Only applies to SKILL.md-based skills (which own a directory); single-file
 * commands/agents have no bundle. Each script found is scanned for secrets/traps.
 */
export function enumerateBundle(skillAbsPath: string): Bundle {
  if (!/(^|\/)skill\.md$/i.test(skillAbsPath)) return EMPTY;
  const root = dirname(skillAbsPath);
  const scripts: BundledScript[] = [];
  let otherFiles = 0;
  let count = 0;

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (count >= MAX_FILES) return;
      const abs = join(dir, name);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (name !== "node_modules" && name !== ".git") walk(abs);
        continue;
      }
      if (abs === skillAbsPath) continue; // the SKILL.md prose is scanned elsewhere
      count++;
      const ext = extname(name).toLowerCase();
      const lang = SCRIPT_LANG[ext];
      const rel = relative(root, abs);

      // 1. A bundled script — scan as code (secrets + traps).
      if (lang) {
        scripts.push({
          path: rel,
          language: lang,
          bytes: s.size,
          findings: s.size > MAX_BYTES ? [] : scanCode(rel, readFileSync(abs, "utf8"), lang),
        });
        continue;
      }

      // 2. A bundled MCP config (.json wiring the agent to a server) — scan for
      //    MCP risk: unpinned servers, embedded secrets, injected tool descriptions.
      if (ext === ".json" && s.size <= MAX_BYTES) {
        const content = readFileSync(abs, "utf8");
        if (looksMcpConfig(rel, content)) {
          scripts.push({
            path: rel,
            language: "mcp-config",
            bytes: s.size,
            findings: scanMcpConfig(rel, content),
          });
          continue;
        }
      }

      // 3. Everything else — ships with the skill but isn't code we scan.
      otherFiles++;
    }
  };

  walk(root);
  scripts.sort((a, b) => a.path.localeCompare(b.path));
  return { scripts, otherFiles };
}
