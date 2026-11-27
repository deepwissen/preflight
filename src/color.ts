/**
 * Zero-dependency ANSI color. Color only REINFORCES the ✓ ⚠ ✗ symbols — those always
 * carry the meaning (≈1 in 12 men has red-green color blindness), so every wrapper is a
 * no-op when color is off. Color is on only for a real terminal of human output; it's
 * OFF for pipes/redirects (so grep/CI parsers aren't broken) and for --json / --sarif
 * (which the CLI disables explicitly). Honors NO_COLOR (off) and FORCE_COLOR (on).
 */

function decide(): boolean {
  const env = process.env;
  const fc = env.FORCE_COLOR;
  if (fc !== undefined && fc !== "0" && fc !== "false" && fc !== "") return true; // explicit opt-in (e.g. CI logs)
  if (env.NO_COLOR !== undefined) return false; // present at any value → off (no-color.org)
  return Boolean(process.stdout.isTTY);
}

let enabled = decide();

/** Force color off (machine output: --json / --sarif) or on. Checked at call time. */
export function setColorEnabled(on: boolean): void {
  enabled = on;
}

export function colorEnabled(): boolean {
  return enabled;
}

const wrap =
  (open: string) =>
  (s: string): string =>
    enabled ? `\x1b[${open}m${s}\x1b[0m` : s;

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

/** Red+bold together (the act-on-it elements: ✗, [error], the "blocked —" line). */
export const redBold = (s: string): string => bold(red(s));
