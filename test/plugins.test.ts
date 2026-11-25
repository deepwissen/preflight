import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins } from "../src/plugins.js";
import { renderPlugins } from "../src/render.js";

let fakeHome: string;
let prevHome: string | undefined;

const RISKY_MCP = `{
  "mcpServers": {
    "db": {
      "command": "npx",
      "args": ["-y", "server@latest"],
      "env": { "AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }
    }
  }
}`;

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "preflight-plugins-"));
  const plugins = join(fakeHome, ".claude", "plugins");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, "known_marketplaces.json"),
    JSON.stringify({ acme: { source: { source: "github", repo: "acme/plugins" } } })
  );
  // one plugin: a connector with a bundled skill + a risky root .mcp.json
  const p = join(plugins, "marketplaces", "acme", "plugins", "mcp-connector");
  mkdirSync(join(p, "skills", "wire"), { recursive: true });
  mkdirSync(join(p, "commands"), { recursive: true });
  writeFileSync(join(p, "plugin.json"), JSON.stringify({ name: "mcp-connector", version: "1.0.0" }));
  writeFileSync(
    join(p, "skills", "wire", "SKILL.md"),
    "---\nname: wire\ndescription: Wire the DB\nallowed-tools: Read\n---\nGo.\n"
  );
  writeFileSync(join(p, "commands", "connect.md"), "---\ndescription: connect\n---\nConnect.\n");
  writeFileSync(join(p, ".mcp.json"), RISKY_MCP);

  prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("discoverPlugins", () => {
  it("inventories the plugin with provenance + bundle counts, and scans its MCP config", () => {
    const plugins = discoverPlugins();
    expect(plugins).toHaveLength(1);
    const p = plugins[0];
    expect(p.name).toBe("mcp-connector");
    expect(p.marketplace).toBe("acme");
    expect(p.source).toBe("github:acme/plugins");
    expect(p.skills).toBe(1);
    expect(p.commands).toBe(1);
    expect(p.hasMcp).toBe(true);
    expect(p.findings.length).toBeGreaterThan(0); // the risky .mcp.json
    expect(p.findings.some((f) => f.file.includes(".mcp.json"))).toBe(true);
  });

  it("renders provenance, the bundle summary, and the hooks-not-scanned caveat", () => {
    const view = renderPlugins(discoverPlugins());
    expect(view).toContain("mcp-connector");
    expect(view).toContain("github:acme/plugins");
    expect(view).toContain("NEEDS ATTENTION");
    expect(view).toContain("MCP configs, and hooks");
    expect(view).toContain("not a guarantee the plugin is safe");
  });
});
