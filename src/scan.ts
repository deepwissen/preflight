import {
  scanSecrets,
  scanInstructionIntegrity,
  scanSkillScope,
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
