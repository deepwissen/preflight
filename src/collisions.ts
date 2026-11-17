import type { SkillRow } from "./manifest.js";
import type { ScopeName } from "./scopes.js";

// Skill-name precedence (highest wins), from Claude Code's documented resolution:
// Enterprise > Personal (user) > Project > added-dir > bundled. We only scan user
// and project; the rest are here for completeness/future scopes.
const PRECEDENCE: Record<string, number> = { enterprise: 4, user: 3, project: 2, added: 1 };
function prec(origin?: ScopeName): number {
  return origin ? (PRECEDENCE[origin] ?? 0) : 0;
}

/** The invocation name of a skill — its declared `name`, else derived from path. */
export function skillName(r: SkillRow): string {
  if (r.name) return r.name;
  const parts = r.path.split("/");
  const file = parts.pop() ?? r.path;
  return /^skill\.md$/i.test(file) ? (parts.pop() ?? file) : file.replace(/\.md$/i, "");
}

export interface SkillRef {
  path: string;
  origin?: ScopeName;
}

export interface Collision {
  name: string;
  sameScope: boolean; // no cross-scope precedence applies → resolution unspecified
  winner?: SkillRef; // the skill that actually runs (undefined when sameScope)
  shadowed: SkillRef[]; // skills that never run (or all of them, when sameScope)
}

export interface Ambiguity {
  a: { name: string; path: string };
  b: { name: string; path: string };
  similarity: number; // 0..1 Jaccard over description terms
  sharedTerms: string[];
}

const ref = (r: SkillRow): SkillRef => ({ path: r.path, origin: r.origin });

/**
 * Group skills by invocation name; any name with >1 skill is a collision. With
 * cross-scope origins, the highest-precedence skill wins and the rest are shadowed
 * (silently — Claude Code shows no warning). Within one scope, resolution is
 * undocumented, so we flag it as unspecified rather than guess a winner.
 */
export function detectCollisions(rows: SkillRow[]): Collision[] {
  const byName = new Map<string, SkillRow[]>();
  for (const r of rows) {
    const key = skillName(r).toLowerCase();
    const arr = byName.get(key);
    if (arr) arr.push(r);
    else byName.set(key, [r]);
  }

  const out: Collision[] = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => prec(b.origin) - prec(a.origin));
    const topRank = prec(ranked[0].origin);
    const topCount = ranked.filter((r) => prec(r.origin) === topRank).length;
    const sameScope = topCount > 1; // a tie at the top rank → no definitive winner
    out.push({
      name,
      sameScope,
      winner: sameScope ? undefined : ref(ranked[0]),
      shadowed: (sameScope ? ranked : ranked.slice(1)).map(ref),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Low-signal words that shouldn't drive description similarity.
const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "your", "this",
  "that", "it", "is", "are", "be", "when", "use", "uses", "using", "skill", "claude",
  "user", "users", "from", "into", "as", "by", "you", "they", "their", "will", "can",
]);

function terms(desc: string): Set<string> {
  return new Set(
    desc
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

/**
 * Flag pairs of differently-named skills whose descriptions overlap enough that the
 * model's (non-deterministic) choice between them is unpredictable. Same-name pairs
 * are collisions, handled above, so they're excluded here.
 */
export function detectAmbiguities(rows: SkillRow[], threshold = 0.5): Ambiguity[] {
  const items = rows
    .filter((r) => r.scope.description)
    .map((r) => ({ name: skillName(r), path: r.path, t: terms(r.scope.description as string) }))
    .filter((x) => x.t.size >= 3); // too-short descriptions are noise

  const out: Ambiguity[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i];
      const B = items[j];
      if (A.name.toLowerCase() === B.name.toLowerCase()) continue; // that's a collision
      const shared = [...A.t].filter((w) => B.t.has(w));
      const union = new Set([...A.t, ...B.t]).size;
      const similarity = shared.length / union;
      if (similarity >= threshold) {
        out.push({
          a: { name: A.name, path: A.path },
          b: { name: B.name, path: B.path },
          similarity,
          sharedTerms: shared,
        });
      }
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity);
}

export interface Conflicts {
  collisions: Collision[];
  ambiguities: Ambiguity[];
}

export function analyzeConflicts(rows: SkillRow[]): Conflicts {
  return { collisions: detectCollisions(rows), ambiguities: detectAmbiguities(rows) };
}
