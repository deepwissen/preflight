import type { Finding } from "./scan.js";

/**
 * Dangerous-command detection shared by every surface that scans shell/script text:
 * auto-run hooks (prefix "hook") and the scripts a skill bundles (prefix "script").
 * Content-only — no execution. Each caller gets surface-specific rule ids
 * (e.g. hook-fetch-execute vs script-fetch-execute).
 *
 * Precision matters: these gate `add`, so a false positive trains users to pass
 * --force. Single benign calls (os.dup2 to /dev/null, a ~/.ssh mention in a comment)
 * must NOT fire — only genuine multi-signal attacks do.
 */

// Simple, unambiguous text-level patterns.
const FETCH_EXECUTE = /\b(?:curl|wget|fetch)\b[^|&;]*\|\s*(?:sh|bash|zsh|python3?|node|deno)\b|\beval\b[^;]*\$\((?:curl|wget)\b/i;
const OBFUSCATED_EXEC = /\bbase64\s+(?:-d|--decode|-D)\b[^|]*\|\s*(?:sh|bash|zsh|python3?|node)\b/i;
const DESTRUCTIVE = /\brm\s+-[rf]{1,2}\s+(?:\/(?!tmp\b)|~\/|\$HOME\b)/i;

// Reverse shells. Strong single-signal forms (bash /dev/tcp, netcat -e) are
// unambiguous. The python form needs a socket connection AND a shell handoff in the
// same file — a bare os.dup2() (e.g. redirecting stdout to /dev/null) is not a shell.
const REVSHELL_STRONG = /\/dev\/tcp\/[\w.$-]+\/\d|bash\s+-i\b[^|\n]*>&?\s*\/dev\/tcp|\bn(?:c|cat)\b\s+(?:-\w+\s+)*-e\b/i;
const SOCKET_CONNECT = /\bsocket\.socket\s*\(|\bsocket\.create_connection\s*\(|\.connect\s*\(\s*\(/i;
const SHELL_HANDOFF = /\bos\.dup2\s*\(|\bpty\.spawn\s*\(\s*["']\/bin\/(?:ba)?sh|subprocess\.(?:call|Popen|run)\s*\(\s*\[?\s*["']\/bin\/(?:ba)?sh["']/i;

function hasReverseShell(text: string): boolean {
  return REVSHELL_STRONG.test(text) || (SOCKET_CONNECT.test(text) && SHELL_HANDOFF.test(text));
}

// Credential theft: a credential PATH plus a read/send ACTION on the same
// (non-comment) line. A bare mention of ~/.ssh in a comment, or a .pem used by
// ordinary TLS code, must not fire. (Bare .pem dropped — far too broad.)
const CRED_PATH = /~\/\.ssh\/|\bid_rsa\b|\bid_ed25519\b|~\/\.aws\/credentials|\bcredentials\.json\b/i;
const READ_SEND =
  /\b(?:cat|less|more|head|tail|cp|mv|scp|rsync|curl|wget|nc|base64|xxd|openssl|tar|zip|dd|open|read|readFile|readFileSync|readFileText|ReadAllText|Get-Content)\b|[<>]/i;
const COMMENT_LINE = /^\s*(?:#|\/\/|\/\*|\*|<!--|;|--)/;

function hasCredentialTheft(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (COMMENT_LINE.test(line)) continue; // skip comments — defensive mentions aren't theft
    if (CRED_PATH.test(line) && READ_SEND.test(line)) return true;
  }
  return false;
}

interface Hit {
  kind: string;
  severity: Finding["severity"];
  what: string;
}

/** Scan shell/script text for dangerous commands. `prefix` ("hook" / "script" / "mcp")
 *  becomes the rule-id prefix. `where` is a human label (empty → message is just the
 *  reason, letting the caller/renderer supply the file location). */
export function scanDangerous(text: string, where: string, prefix: string): Finding[] {
  const hits: Hit[] = [];
  if (FETCH_EXECUTE.test(text))
    hits.push({ kind: "fetch-execute", severity: "error", what: "fetches a remote script and pipes it to a shell (remote code execution)" });
  if (OBFUSCATED_EXEC.test(text))
    hits.push({ kind: "obfuscated-exec", severity: "error", what: "decodes base64 and pipes it to a shell (obfuscated execution)" });
  if (hasReverseShell(text))
    hits.push({ kind: "reverse-shell", severity: "error", what: "opens a reverse shell — socket connection plus a shell handoff (remote code execution)" });
  if (hasCredentialTheft(text))
    hits.push({ kind: "credential-access", severity: "error", what: "reads a credential file and pipes/sends it (credential theft)" });
  if (DESTRUCTIVE.test(text))
    hits.push({ kind: "destructive", severity: "error", what: "runs a destructive rm -rf on a home/root path" });

  return hits.map((h) => ({
    severity: h.severity,
    rule: `${prefix}-${h.kind}`,
    message: where ? `${where}: ${h.what}` : h.what,
    suggestion:
      prefix === "hook"
        ? "this runs automatically on the event — remove the dangerous command or vet the remote source"
        : "the agent can be told to run this — remove the dangerous command or don't install it",
  }));
}
