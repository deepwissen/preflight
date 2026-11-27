import { describe, it, expect } from "vitest";
import { toPosix } from "../src/paths.js";

describe("toPosix (Windows path normalization)", () => {
  it("converts backslashes to forward slashes so exact file-name checks work", () => {
    expect(toPosix("scripts\\.env")).toBe("scripts/.env");
    expect(toPosix("scripts\\.env").split("/").pop()).toBe(".env"); // the Windows bug
    expect(toPosix("a\\b\\Makefile").split("/").pop()).toBe("Makefile");
    expect(toPosix("sub\\pkg\\package.json").split("/").pop()).toBe("package.json");
  });
  it("leaves POSIX paths unchanged and handles mixed separators", () => {
    expect(toPosix("scripts/.env")).toBe("scripts/.env");
    expect(toPosix("a\\b/c")).toBe("a/b/c");
  });
});
