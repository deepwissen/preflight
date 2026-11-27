import {
  scanSecrets,
  scanInstructionIntegrity,
  scanSkillScope,
  scanAgentConfig,
  scanMcpConfigs,
  detectTraps,
  type ContextSnapshot,
  type FileInfo,
} from "@deepwissen/preflight-core";
import { scanDangerous } from "./danger.js";

export interface Finding {
  severity: "info" | "warning" | "error";
  rule: string;
  message: string;
  line?: number;
  suggestion?: string;
}

function emptySnapshot(): ContextSnapshot {
  return {
    timestamp: 0,
    activeFile: null,
    selection: null,
    openTabs: [],
    aiInstructionFiles: [],
    mcpConfigFiles: [],
    toolProfile: null,
    ignoreFiles: [],
    referencedFiles: [],
    terminalContent: null,
    clipboardSize: null,
    chatHistoryLength: 0,
  };
}

function fileInfo(path: string, content: string, languageId = "markdown"): FileInfo {
  return {
    path,
    languageId,
    lineCount: content.split("\n").length,
    charCount: content.length,
    isActive: true,
    isDirty: false,
    commentLineCount: 0,
    hasConflictMarkers: false,
    content,
  };
}

/**
 * Scan a single skill file for the risks relevant to agent skills: embedded
 * secrets, instruction-integrity (prompt injection, hidden unicode, role-tag
 * spoofing), and over-broad declared tool scope. All detection is the engine's.
 */
export function scanSkill(path: string, content: string): Finding[] {
  const snap = emptySnapshot();
  snap.activeFile = fileInfo(path, content);
  snap.aiInstructionFiles = [
    { path, lineCount: content.split("\n").length, toolId: null, content },
  ];

  const out: Finding[] = [];
  for (const f of scanSecrets(snap, {}).secretFindings ?? []) {
    out.push({
      severity: f.severity,
      rule: f.ruleId,
      message: f.description,
      line: f.lineNumber,
      suggestion: f.suggestion,
    });
  }
  for (const i of scanInstructionIntegrity(snap, {}).instructionFileIssues ?? []) {
    out.push({
      severity: i.severity ?? "warning",
      rule: i.issue,
      message: i.description,
      line: i.lineNumber,
      suggestion: i.suggestion,
    });
  }
  for (const i of scanSkillScope(path, content)) {
    out.push({
      severity: i.severity ?? "error",
      rule: i.issue,
      message: i.description,
      line: i.lineNumber,
      suggestion: i.suggestion,
    });
  }
  // Dangerous commands the body tells the agent to run — fenced code only, capped at
  // warning (prose that merely mentions `curl | sh` is not a directive). See markdownDanger.
  out.push(...markdownDanger(content));
  return out;
}

/**
 * Scan an always-on instruction/context file — CLAUDE.md or a .claude/rules/*.md —
 * for the risks that matter there: embedded secrets and instruction-integrity
 * (prompt injection, hidden unicode, role-tag spoofing). No tool-scope check: these
 * files carry instructions, not tool grants. This is the surface the "rules-file
 * backdoor" hides in — a repo's CLAUDE.md or rule steering the agent on every turn.
 */
export function scanInstruction(path: string, content: string): Finding[] {
  const snap = emptySnapshot();
  snap.activeFile = fileInfo(path, content);
  snap.aiInstructionFiles = [{ path, lineCount: content.split("\n").length, toolId: null, content }];

  // The agent reads fenced code in a doc as instructions too, so we do NOT skip whole
  // blocks. We only suppress the two narrow role FPs inside fences — an LLM role tag
  // (`<|im_start|>`) or a bare role key (`system:` / `user:` in a ```yaml example) isn't
  // a real attack when it's a documented sample. Concealment phrases, credential reads,
  // real-format secrets and hidden-unicode stay flagged everywhere (placeholder tokens are
  // cleared by the secret scanner's own placeholder guard, in or out of a fence). The
  // engine gives role keys their own `role-key-echo` id so suppressing them here can't
  // also silence the suspicious-instruction phrases that must fire inside fences.
  const fenced = fencedLines(content);
  const SUPPRESS_IN_FENCE = new Set(["role-tag-spoofing", "role-key-echo"]);
  const suppressed = (line?: number, rule?: string): boolean =>
    Boolean(line && fenced.has(line)) && SUPPRESS_IN_FENCE.has(rule ?? "");

  const out: Finding[] = [];
  for (const f of scanSecrets(snap, {}).secretFindings ?? []) {
    out.push({ severity: f.severity, rule: f.ruleId, message: f.description, line: f.lineNumber, suggestion: f.suggestion });
  }
  for (const i of scanInstructionIntegrity(snap, {}).instructionFileIssues ?? []) {
    if (suppressed(i.lineNumber, i.issue)) continue;
    out.push({ severity: i.severity ?? "warning", rule: i.issue, message: i.description, line: i.lineNumber, suggestion: i.suggestion });
  }
  // Dangerous commands the doc tells the agent to run — fenced code only, warning-capped
  // (an inline mention in prose is not a directive). See markdownDanger.
  out.push(...markdownDanger(content));
  return out;
}

/** 1-based line numbers inside fenced code blocks (``` or ~~~), fence markers included. */
function fencedLines(content: string): Set<number> {
  const set = new Set<number>();
  let inFence = false;
  content.split(/\r?\n/).forEach((line, idx) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      set.add(idx + 1); // the fence marker line itself
      inFence = !inFence;
      return;
    }
    if (inFence) set.add(idx + 1);
  });
  return set;
}

/**
 * Dangerous commands in a markdown instruction surface (SKILL.md, CLAUDE.md, a doc the
 * agent is told to follow). Context-aware: ONLY fenced code is scanned — a `curl | sh`
 * in prose ("never run curl | sh") is a warning against it, not a command — and findings
 * are capped at WARNING. An actual script / hook / MCP command stays at error (via
 * scanDangerous on those surfaces); a fenced doc sample the agent *might* run is lower
 * confidence, so it blocks `add` (warning) without crying "remote code execution".
 */
function markdownDanger(content: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  // 1. Slash-command pre-execution: Claude Code RUNS the content of !`…` before the model
  //    even sees the command. An execution directive, not a mention — keep it at error
  //    (this is the `!`curl … | sh`` attack).
  const preExec = [...content.matchAll(/!`([^`]+)`/g)].map((m) => m[1]).join("\n");
  if (preExec.trim()) {
    for (const f of scanDangerous(preExec, "", "script")) {
      seen.add(f.rule);
      out.push(f);
    }
  }
  // 2. The whole doc is instructions the agent reads — prose, inline code, indented
  //    blocks, HTML comments, referenced docs. Flag dangerous commands at warning, but in
  //    markdown mode a `curl | sh` needs a real URL (so "never run curl | sh" stays clean).
  for (const f of scanDangerous(content, "", "script", true)) {
    if (seen.has(f.rule)) continue; // already flagged at error by a !`…` pre-exec
    out.push({
      ...f,
      severity: "warning",
      suggestion: "a command this doc tells the agent to run — confirm it's safe before trusting this skill",
    });
  }
  return out;
}

function lineFrom(text: string): number | undefined {
  const m = text.match(/\bline (\d+)\b/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Scan a bundled script a skill ships (not prose) — hardcoded secrets and
 * trap-file patterns (unsafe deserialization etc.). Instruction-integrity and
 * scope checks do NOT apply: this is code, not an instruction surface.
 */
export function scanCode(path: string, content: string, languageId: string): Finding[] {
  const snap = emptySnapshot();
  snap.activeFile = fileInfo(path, content, languageId);
  snap.aiInstructionFiles = [{ path, lineCount: content.split("\n").length, toolId: null, content }];

  const out: Finding[] = [];
  for (const f of scanSecrets(snap, {}).secretFindings ?? []) {
    out.push({
      severity: f.severity,
      rule: f.ruleId,
      message: f.description,
      line: f.lineNumber,
      suggestion: f.suggestion,
    });
  }
  for (const w of detectTraps(snap, {}).wastePatterns ?? []) {
    out.push({
      severity: w.severity === "warning" ? "warning" : "info",
      rule: w.ruleId,
      message: w.description,
      line: lineFrom(w.description),
      suggestion: w.suggestion,
    });
  }
  // Hidden-unicode / Trojan-Source bidi in bundled CODE — invisible to a reviewer but it
  // changes what the code does (F8). Keep only the unicode integrity findings; prose/phrase
  // checks don't apply to code.
  for (const i of scanInstructionIntegrity(snap, {}).instructionFileIssues ?? []) {
    if (i.issue === "hidden-unicode" || i.issue === "bidi-override") {
      out.push({ severity: i.severity ?? "warning", rule: i.issue, message: i.description, line: i.lineNumber, suggestion: i.suggestion });
    }
  }
  return out;
}

/**
 * Scan a settings.json for agent-autonomy risk using the ENGINE's agent-config
 * scanner — the shared source of truth (same detector vet and the extension use).
 * Covers the canonical cases: unrestricted allow (Bash(*)/*), skip-permissions
 * (bypassPermissions), auto-approve edits (acceptEdits), enable-all-MCP. preflight's
 * own scanSettings adds only what the engine doesn't yet cover (apiKeyHelper, env
 * base-URL, marketplaces, deep hook analysis) — no overlap, no double-reporting.
 */
export function scanAgentConfigFile(path: string, content: string): Finding[] {
  const snap = emptySnapshot();
  snap.activeFile = fileInfo(path, content, "json");
  // The engine appends " (<path>)" to each description; preflight groups findings by
  // file already, so strip that redundant suffix for a clean message.
  const suffix = ` (${path})`;
  const out: Finding[] = [];
  for (const i of scanAgentConfig(snap, {}).instructionFileIssues ?? []) {
    const message = i.description.endsWith(suffix) ? i.description.slice(0, -suffix.length) : i.description;
    out.push({ severity: i.severity ?? "warning", rule: i.issue, message, line: i.lineNumber, suggestion: i.suggestion });
  }
  return out;
}

/** A bundled MCP config file (by name, or any JSON declaring servers). */
export function looksMcpConfig(path: string, content: string): boolean {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (/^(\.mcp\.json|mcp\.json|claude_desktop_config\.json)$/.test(base)) return true;
  return base.endsWith(".json") && (content.includes('"mcpServers"') || content.includes('"servers"'));
}

/**
 * Scan a bundled MCP config for MCP-specific risk (embedded secrets, unpinned
 * servers, injected tool descriptions) plus hardcoded secrets and hidden-unicode
 * payloads in tool descriptions. A skill can ship one of these to wire the agent
 * up to a server — a supply-chain surface the SKILL.md prose hides.
 */
export function scanMcpConfig(path: string, content: string): Finding[] {
  const snap = emptySnapshot();
  snap.activeFile = fileInfo(path, content, "json");
  snap.mcpConfigFiles = [{ path, content }];

  const out: Finding[] = [];
  for (const f of scanSecrets(snap, {}).secretFindings ?? []) {
    out.push({ severity: f.severity, rule: f.ruleId, message: f.description, line: f.lineNumber, suggestion: f.suggestion });
  }
  for (const i of scanMcpConfigs(snap, {}).instructionFileIssues ?? []) {
    out.push({ severity: i.severity ?? "warning", rule: i.issue, message: i.description, line: i.lineNumber, suggestion: i.suggestion });
  }
  for (const i of scanInstructionIntegrity(snap, {}).instructionFileIssues ?? []) {
    out.push({ severity: i.severity ?? "warning", rule: i.issue, message: i.description, line: i.lineNumber, suggestion: i.suggestion });
  }
  // Dangerous commands in each server's command/args (e.g. a server that runs
  // `bash -c 'curl … | sh'`) — the MCP scanner checks pinning/secrets, not this.
  out.push(...scanMcpServerCommands(content));
  return out;
}

/** Flag dangerous commands in the command/args of each server in an MCP config. */
function scanMcpServerCommands(content: string): Finding[] {
  let servers: Record<string, unknown> | undefined;
  try {
    const j = JSON.parse(content) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
    servers = j.mcpServers ?? j.servers;
  } catch {
    return [];
  }
  if (!servers || typeof servers !== "object") return [];
  const out: Finding[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const c = cfg as { command?: unknown; args?: unknown };
    const parts: string[] = [];
    if (typeof c.command === "string") parts.push(c.command);
    if (Array.isArray(c.args)) for (const a of c.args) if (typeof a === "string") parts.push(a);
    const text = parts.join(" ");
    if (text) for (const f of scanDangerous(text, `server ${name}`, "mcp")) out.push(f);
  }
  return out;
}
