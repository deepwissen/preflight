import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateBundle } from "../src/bundle.js";
import { buildRow, flatFindings } from "../src/manifest.js";
import { looksMcpConfig } from "../src/scan.js";

let root: string;
let skillAbs: string;

const RISKY_MCP = `{
  "mcpServers": {
    "db": {
      "command": "npx",
      "args": ["-y", "some-mcp-server@latest"],
      "env": { "AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }
    }
  }
}`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "preflight-mcpbundle-"));
  const dir = join(root, ".claude", "skills", "connector");
  mkdirSync(dir, { recursive: true });
  skillAbs = join(dir, "SKILL.md");
  writeFileSync(skillAbs, "---\nname: connector\ndescription: Wire up a DB\nallowed-tools: Read\n---\nUse the bundled MCP server.\n");
  writeFileSync(join(dir, ".mcp.json"), RISKY_MCP); // the bundled config
  writeFileSync(join(dir, "notes.txt"), "just notes\n"); // a genuine 'other' file
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("looksMcpConfig", () => {
  it("recognizes .mcp.json and any JSON declaring servers", () => {
    expect(looksMcpConfig(".mcp.json", "{}")).toBe(true);
    expect(looksMcpConfig("config.json", '{ "mcpServers": {} }')).toBe(true);
    expect(looksMcpConfig("data.json", '{ "name": "x" }')).toBe(false);
    expect(looksMcpConfig("run.sh", 'echo "mcpServers"')).toBe(false);
  });
});

describe("bundled .mcp.json is scanned for MCP risk", () => {
  it("enumerates the config as scanned (not 'other') and flags its risk", () => {
    const b = enumerateBundle(skillAbs);
    const mcp = b.scripts.find((s) => s.path === ".mcp.json");
    expect(mcp).toBeDefined();
    expect(mcp!.language).toBe("mcp-config");
    expect(mcp!.findings.length).toBeGreaterThan(0); // embedded secret / unpinned server
    expect(b.otherFiles).toBe(1); // only notes.txt is 'other'
  });

  it("rolls the config's findings into the skill's counts and flat findings", () => {
    const row = buildRow(skillAbs, ".claude/skills/connector/SKILL.md");
    expect(row.errorCount + row.warnCount).toBeGreaterThan(0);
    expect(flatFindings(row).some((f) => f.file === ".mcp.json")).toBe(true);
  });
});
