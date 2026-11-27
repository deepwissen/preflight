import type { Finding } from "./scan.js";

/**
 * Dangerous-command patterns shared by every surface that scans shell/script text:
 * auto-run hooks (prefix "hook") and the scripts a skill bundles (prefix "script").
 * Content-only regex — no execution. Each caller gets surface-specific rule ids
 * (e.g. hook-fetch-execute vs script-fetch-execute) from the same pattern list.
 */
export interface DangerRule {
  re: RegExp;
  kind: string; // becomes `${prefix}-${kind}`
  severity: Finding["severity"];
  what: string;
}

export const DANGEROUS: DangerRule[] = [
  {
    re: /\b(?:curl|wget|fetch)\b[^|&;]*\|\s*(?:sh|bash|zsh|python3?|node|deno)\b/i,
    kind: "fetch-execute",
    severity: "error",
    what: "fetches a remote script and pipes it to a shell (remote code execution)",
  },
  {
    re: /\beval\b[^;]*\$\((?:curl|wget)\b/i,
    kind: "fetch-execute",
    severity: "error",
    what: "evals the output of a remote fetch (remote code execution)",
  },
  {
    re: /\bbase64\s+(?:-d|--decode|-D)\b[^|]*\|\s*(?:sh|bash|zsh|python3?|node)\b/i,
    kind: "obfuscated-exec",
    severity: "error",
    what: "decodes base64 and pipes it to a shell (obfuscated execution)",
  },
  {
    // Reverse shells: /dev/tcp redirect, netcat -e, and the classic Python
    // socket+dup2+/bin/sh / pty.spawn forms.
    re: /\/dev\/tcp\/[\w.$-]+\/\d|bash\s+-i\b[^|\n]*>&?\s*\/dev\/tcp|\bn(?:c|cat)\b\s+(?:-\w+\s+)*-e\b|\bos\.dup2\s*\(|\bpty\.spawn\s*\(\s*["']\/bin\/(?:ba)?sh|subprocess\.(?:call|Popen|run)\s*\(\s*\[?\s*["']\/bin\/(?:ba)?sh["']/i,
    kind: "reverse-shell",
    severity: "error",
    what: "opens a reverse shell (remote code execution)",
  },
  {
    re: /(?:~\/\.ssh\/|\bid_rsa\b|\bid_ed25519\b|~\/\.aws\/credentials|\.pem\b)/i,
    kind: "credential-access",
    severity: "warning",
    what: "touches credential files (SSH / AWS keys)",
  },
  {
    re: /\brm\s+-[rf]{1,2}\s+(?:\/(?!tmp\b)|~\/|\$HOME\b)/i,
    kind: "destructive",
    severity: "error",
    what: "runs a destructive rm -rf on a home/root path",
  },
];

/** Scan shell/script text for dangerous commands. `prefix` is "hook" or "script".
 *  `where` is a human label (e.g. "hook PreToolUse command" / "script scripts/calc.py"). */
export function scanDangerous(text: string, where: string, prefix: "hook" | "script"): Finding[] {
  const out: Finding[] = [];
  for (const d of DANGEROUS) {
    if (d.re.test(text)) {
      out.push({
        severity: d.severity,
        rule: `${prefix}-${d.kind}`,
        message: where ? `${where}: ${d.what}` : d.what,
        suggestion:
          prefix === "hook"
            ? "this runs automatically on the event — remove the dangerous command or vet the remote source"
            : "the agent can be told to run this bundled script — remove the dangerous command or don't install it",
      });
    }
  }
  return out;
}
