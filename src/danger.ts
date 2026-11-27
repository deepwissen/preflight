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
// A catastrophic recursive delete — only the filesystem root, the home dir, or a
// top-level system dir counts. A specific subfolder (`rm -rf /workspace/reports`,
// `rm -rf ~/project/build`) is ordinary cleanup, not an attack.
const DESTRUCTIVE =
  /\brm\s+-[rf]{1,2}\s+(?:--?\w[\w-]*\s+)*(?:\/(?:\s|$|\*|;|&)|~\/?(?:\s|$|\*)|\$\{?HOME\}?\/?(?:\s|$|\*)?|\/(?:etc|usr|s?bin|var|lib(?:64)?|boot|sys|dev|proc|root|home|opt)(?:\/|\s|$|\*))/i;
// Download-to-file, make executable, and run it — the two-step form FETCH_EXECUTE's
// pipe check misses (`curl … -o /tmp/b && chmod +x /tmp/b && /tmp/b`). Needs BOTH a
// download-to-file and a chmod +x so a plain `curl -o file` download stays clean.
const DOWNLOAD_RUN = (t: string): boolean =>
  /\b(?:curl|wget)\b[^\n]*\s-[oO]\b/i.test(t) && /\bchmod\s+(?:\+x|[0-7]*[1357][0-7]?)\b/i.test(t);
// Fetch-and-eval inside a language runtime (no shell pipe): python `exec(urlopen(…))`,
// `eval(requests.get(…).text)`, etc.
const LANG_FETCH_EXEC = /\b(?:exec|eval)\s*\([^\n]*\b(?:urlopen|urllib|requests\.(?:get|post))\b/i;
// PowerShell download-and-run: iex / Invoke-Expression of iwr / Invoke-WebRequest /
// DownloadString / Net.WebClient.
const PS_FETCH_EXEC =
  /\b(?:iex|invoke-expression)\b[^\n]*\b(?:iwr|invoke-webrequest|downloadstring|net\.webclient|curl|wget)\b/i;
// Environment dump piped straight to the network (`env | curl -d @-`) — exfiltration.
const ENV_EXFIL = /\b(?:env|printenv)\b\s*\|\s*(?:curl|wget|nc|ncat)\b/i;
// The session transcript read and piped to the network — a hook gets transcript_path
// on stdin; `… .transcript_path | … cat | curl -d @- host` exfiltrates the conversation.
const TRANSCRIPT_EXFIL = /\btranscript_path\b[\s\S]*\|[\s\S]*\b(?:curl|wget|nc|ncat)\b/i;

// Reverse shells. Strong single-signal forms (bash /dev/tcp, netcat -e) are
// unambiguous. The python form needs a socket connection AND a shell handoff in the
// same file — a bare os.dup2() (e.g. redirecting stdout to /dev/null) is not a shell.
const REVSHELL_STRONG = /\/dev\/tcp\/[\w.$-]+\/\d|bash\s+-i\b[^|\n]*>&?\s*\/dev\/tcp|\bn(?:c|cat)\b\s+(?:-\w+\s+)*-e\b/i;
const SOCKET_CONNECT = /\bsocket\.socket\s*\(|\bsocket\.create_connection\s*\(|\.connect\s*\(\s*\(/i;
const SHELL_HANDOFF = /\bos\.dup2\s*\(|\bpty\.spawn\s*\(\s*["']\/bin\/(?:ba)?sh|subprocess\.(?:call|Popen|run)\s*\(\s*\[?\s*["']\/bin\/(?:ba)?sh["']/i;

function hasReverseShell(text: string): boolean {
  return REVSHELL_STRONG.test(text) || (SOCKET_CONNECT.test(text) && SHELL_HANDOFF.test(text));
}

// Credential theft: a credential PATH plus a read/send ACTION, in non-comment code
// anywhere in the SAME FILE (real code splits `p = expanduser("~/.aws/credentials")`
// from `open(p).read()`). Path is prefix-agnostic — ~/, $HOME/, os.homedir()+ all
// resolve to .aws/credentials or .ssh/id_*. Comment-only mentions and ordinary TLS
// (.pem) are ignored.
const CRED_PATH =
  /\.aws\/credentials|\.ssh\/(?:id_\w+|authorized_keys)|\bid_rsa\b|\bid_ed25519\b|\bcredentials\.json\b|\.netrc\b|gh\/hosts\.ya?ml|\.config\/gh\b/i;
const READ_SEND =
  /\b(?:cat|less|more|head|tail|cp|mv|scp|rsync|curl|wget|nc|ncat|base64|xxd|openssl|tar|zip|dd|open|read|readFile|readFileSync|ReadAllText|Get-Content|urlopen|fetch|send|post)\b|requests\.(?:get|post|put)/i;
const COMMENT_LINE = /^\s*(?:#|\/\/|\/\*|\*|<!--|;|--)/;

function hasCredentialTheft(text: string): boolean {
  let path = false;
  let action = false;
  for (const line of text.split(/\r?\n/)) {
    if (COMMENT_LINE.test(line)) continue; // skip comments — defensive mentions aren't theft
    if (!path && CRED_PATH.test(line)) path = true;
    if (!action && READ_SEND.test(line)) action = true;
    if (path && action) return true;
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
  if (DOWNLOAD_RUN(text))
    hits.push({ kind: "download-run", severity: "error", what: "downloads a remote file, marks it executable, and runs it (remote code execution)" });
  if (LANG_FETCH_EXEC.test(text))
    hits.push({ kind: "remote-eval", severity: "error", what: "fetches remote code and exec/evals it in-process (remote code execution)" });
  if (PS_FETCH_EXEC.test(text))
    hits.push({ kind: "ps-fetch-execute", severity: "error", what: "PowerShell downloads and executes remote code (iex/iwr) (remote code execution)" });
  if (ENV_EXFIL.test(text))
    hits.push({ kind: "env-exfil", severity: "error", what: "pipes the environment (secrets) to a remote host (exfiltration)" });
  if (TRANSCRIPT_EXFIL.test(text))
    hits.push({ kind: "transcript-exfil", severity: "error", what: "reads the session transcript and sends it to a remote host (conversation exfiltration)" });
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
