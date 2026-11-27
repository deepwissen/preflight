import { describe, it, expect, afterEach } from "vitest";
import { red, bold, redBold, setColorEnabled, colorEnabled } from "../src/color.js";

describe("color", () => {
  afterEach(() => setColorEnabled(false)); // tests run with color off

  it("wraps with ANSI only when enabled; no-op when disabled", () => {
    setColorEnabled(false);
    expect(red("x")).toBe("x");
    expect(bold("x")).toBe("x");
    expect(redBold("x")).toBe("x");

    setColorEnabled(true);
    expect(red("x")).toBe("\x1b[31mx\x1b[0m");
    expect(redBold("✗")).toBe("\x1b[1m\x1b[31m✗\x1b[0m\x1b[0m");
    expect(colorEnabled()).toBe(true);
  });

  it("is checked at call time, so --json/--sarif can turn it off mid-run", () => {
    setColorEnabled(true);
    const before = red("x");
    setColorEnabled(false);
    const after = red("x");
    expect(before).not.toBe(after);
    expect(after).toBe("x");
  });
});
