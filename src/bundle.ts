import { readdirSync, lstatSync, readlinkSync, readFileSync } from "node:fs";
import { join, dirname, relative, extname, resolve, sep } from "node:path";
import { scanCode, scanInstruction, scanMcpConfig, looksMcpConfig, type Finding } from "./scan.js";
import { scanDangerous } from "./danger.js";

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

// Data files that carry no "code" but are the single most likely place a real
// credential ships with a skill: dotenv, private keys/certs, cloud + VCS creds.
// Scanned for secrets even though they aren't scripts.
const SECRET_FILE =
  /(^|\/)\.env(\.[\w.-]+)?$|(^|\/)\.netrc$|(^|\/)\.pgpass$|(^|\/)credentials$|\.(pem|key|pfx|p12|ppk|asc)$|(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa)$|(^|\/)hosts\.ya?ml$/i;

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
        s = lstatSync(abs); // lstat: detect symlinks instead of following them
      } catch {
        continue;
      }
      // A bundled symlink — a skill shouldn't ship one. If it escapes the skill dir it's
      // a read primitive (e.g. notes.md → ~/.aws/credentials). Flag; never follow it.
      if (s.isSymbolicLink()) {
        count++;
        const rel = relative(root, abs);
        let target = "";
        try {
          target = readlinkSync(abs);
        } catch {
          /* unreadable link */
        }
        const resolved = resolve(dir, target);
        const escapes = resolved !== root && !resolved.startsWith(root + sep);
        scripts.push({
          path: rel,
          language: "symlink",
          bytes: 0,
          findings: [
            {
              severity: "error",
              rule: "bundle-symlink",
              message: `symlink → ${target || "?"}${escapes ? " — points outside the skill (possible credential/file exfiltration)" : ""}`,
              suggestion: "a skill shouldn't ship symlinks — don't install it, or remove the link",
            },
          ],
        });
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

      // 1. A bundled script — the agent can be told to run it. Scan as code
      //    (secrets + traps) AND for dangerous commands (curl|sh, reverse shells,
      //    credential exfil, destructive rm).
      if (lang) {
        let findings: Finding[] = [];
        if (s.size <= MAX_BYTES) {
          const content = readFileSync(abs, "utf8");
          // `where` is empty — flatFindings/the renderer already prefix the file path.
          findings = [...scanCode(rel, content, lang), ...scanDangerous(content, "", "script")];
        }
        scripts.push({ path: rel, language: lang, bytes: s.size, findings });
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

      // 3. A bundled .md the skill references (reference.md, etc.) — the agent may
      //    be told to read and follow it, so it's an instruction surface: scan for
      //    prompt-injection / hidden-unicode just like the SKILL.md prose.
      if (ext === ".md" && s.size <= MAX_BYTES) {
        scripts.push({
          path: rel,
          language: "markdown",
          bytes: s.size,
          findings: scanInstruction(rel, readFileSync(abs, "utf8")),
        });
        continue;
      }

      // 4. A bundled secret-bearing data file (.env, key.pem, .netrc, …) — not a
      //    script, but the likeliest place a real credential ships. Scan for secrets.
      if (SECRET_FILE.test(rel) && s.size <= MAX_BYTES) {
        const content = readFileSync(abs, "utf8");
        scripts.push({
          path: rel,
          language: "data",
          bytes: s.size,
          findings: scanCode(rel, content, ext.slice(1) || "plaintext"),
        });
        continue;
      }

      // 5. Everything else — ships with the skill but isn't code/prose we scan.
      otherFiles++;
    }
  };

  walk(root);
  scripts.sort((a, b) => a.path.localeCompare(b.path));
  return { scripts, otherFiles };
}
