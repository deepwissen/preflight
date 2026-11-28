import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { toPosix } from "./paths.js";

/** One accepted finding: a human decided THIS rule on THIS file at THIS content is OK. */
export interface Acceptance {
  rule: string;
  file: string; // repo-root-relative, POSIX separators
  hash: string; // "sha256:…" of the file's content when it was accepted
  reason: string;
  expires?: string; // optional ISO date (YYYY-MM-DD); after it, the acceptance lapses
  acceptedBy?: string;
  acceptedAt?: string;
}

interface AcceptanceFile {
  version: number;
  accepted: Acceptance[];
}

export const ACCEPT_PATH = ".preflight/accepted.json";

/**
 * Load acceptances from the PROJECT ROOT ONLY — never from staged/cloned/scanned
 * content. This is the invariant that stops a malicious skill from shipping its own
 * `.preflight/accepted.json` to pre-accept its payload: the file governs *your*
 * decisions about what *you* install; it never travels with the thing being vetted.
 */
export function loadAcceptances(projectRoot: string): Acceptance[] {
  const file = join(projectRoot, ".preflight", "accepted.json");
  if (!existsSync(file)) return [];
  let parsed: AcceptanceFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as AcceptanceFile;
  } catch {
    return []; // malformed — treat as no acceptances (caller may warn separately)
  }
  if (!parsed || !Array.isArray(parsed.accepted)) return [];
  return parsed.accepted.filter(
    (a) => a && typeof a.rule === "string" && typeof a.file === "string" && typeof a.hash === "string" && typeof a.reason === "string"
  );
}

/** "sha256:<hex>" of a file's bytes, or null if it can't be read. */
export function hashFile(absPath: string): string | null {
  try {
    return "sha256:" + createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

export type AcceptVerdict =
  | { status: "accepted"; reason: string } // suppress from the gate (shown dimmed)
  | { status: "stale"; reason: string } // file changed since acceptance → fire + re-review note
  | { status: "expired"; reason: string } // past its expiry → fire again
  | null; // no matching acceptance

/**
 * Does an acceptance cover (rule, file)? Only `accepted` suppresses the finding from the
 * gate; `stale`/`expired`/null let it fire. `absPath` is where the file's content is read
 * to hash it (so the acceptance self-invalidates when the file changes). `today` is
 * injectable for testing.
 */
export function checkAcceptance(
  rule: string,
  file: string,
  absPath: string,
  acceptances: Acceptance[],
  today: string = new Date().toISOString().slice(0, 10)
): AcceptVerdict {
  const posix = toPosix(file);
  const a = acceptances.find((x) => x.rule === rule && toPosix(x.file) === posix);
  if (!a) return null;
  if (hashFile(absPath) !== a.hash) return { status: "stale", reason: a.reason };
  if (a.expires && a.expires < today) return { status: "expired", reason: a.reason };
  return { status: "accepted", reason: a.reason };
}
