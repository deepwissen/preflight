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

  const out: Finding[] = [];
  for (const f of scanSecrets(snap, {}).secretFindings ?? []) {
    out.push({ severity: f.severity, rule: f.ruleId, message: f.description, line: f.lineNumber, suggestion: f.suggestion });
  }
  for (const i of scanInstructionIntegrity(snap, {}).instructionFileIssues ?? []) {
    out.push({ severity: i.severity ?? "warning", rule: i.issue, message: i.description, line: i.lineNumber, suggestion: i.suggestion });
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
  return out;
}
