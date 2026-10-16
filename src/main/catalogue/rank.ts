import { STACK_TAGS } from "../../domain/stack-tags";
import type { StackProfile } from "../../domain/stack-profile";

/**
 * One entry of the merged catalogue index (`index.ts`): either a skills.sh leaderboard skill, or
 * — when a marketplace skill's name matches one — that same row enriched with `source:
 * "marketplace"` and the plugin that already has it. A marketplace skill with no skills.sh match
 * never becomes an entry here; it already has a row in the Library's other tabs.
 */
export type CatalogueEntrySource = "skills.sh" | "marketplace";

export type CatalogueEntry = Readonly<{
  source: CatalogueEntrySource;
  ownerRepo: string;
  skill: string;
  name: string;
  description?: string;
  path: string | null;
  tags: readonly string[];
  installs: number;
  official: boolean;
  /** Present only when `source === "marketplace"`: the personal or external package that has it. */
  packageName?: string;
  /** The raw GitHub URL to `SKILL.md`, when the snapshot resolved one — for a reader that fetches it itself. */
  url?: string;
}>;

export type RankedCatalogueEntry = Readonly<{ entry: CatalogueEntry; score: number; matchedTags: readonly string[] }>;

const OFFICIAL_BONUS = 1.2;
const MARKETPLACE_BONUS = 1.5;
const NAME_MATCH_WEIGHT = 5;
const TAG_MATCH_WEIGHT = 3;
const DESCRIPTION_MATCH_WEIGHT = 2;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function evidenceCountByTag(profile: StackProfile | null): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  if (profile) for (const tag of profile.tags) counts.set(tag.id, tag.evidence.length);
  return counts;
}

function matchedTagsFor(entry: CatalogueEntry, evidence: ReadonlyMap<string, number>): readonly string[] {
  return entry.tags.filter((tag) => (evidence.get(tag) ?? 0) > 0);
}

/**
 * A tag carried by most of the catalogue (`typescript`, `node`) says little about a fit; a rare
 * one (`expo`, `convex`) says a lot. Inverse document frequency over the entries being ranked.
 */
function tagRarity(entries: readonly CatalogueEntry[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) for (const tag of new Set(entry.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const rarity = new Map<string, number>();
  for (const [tag, count] of counts) rarity.set(tag, Math.log10((entries.length + 1) / count) + 0.1);
  return rarity;
}

const TAG_WEIGHTS = new Map(STACK_TAGS.map((tag) => [tag.id, tag.weight ?? 1]));
const MATCH_WEIGHT = 4;

/** Evidence is damped (one manifest or six say almost the same) and scaled by the tag's weight and rarity. */
function tagEvidenceScore(
  matchedTags: readonly string[],
  evidence: ReadonlyMap<string, number>,
  rarity: ReadonlyMap<string, number>,
): number {
  return matchedTags.reduce(
    (total, tag) =>
      total +
      Math.log2(1 + (evidence.get(tag) ?? 0)) * (TAG_WEIGHTS.get(tag) ?? 1) * (rarity.get(tag) ?? 1) * MATCH_WEIGHT,
    0,
  );
}

function textMatches(entry: CatalogueEntry, query: string): boolean {
  return (
    normalize(entry.name).includes(query) ||
    normalize(entry.description ?? "").includes(query) ||
    entry.tags.some((tag) => normalize(tag).includes(query))
  );
}

function queryScore(entry: CatalogueEntry, query: string): number {
  if (normalize(entry.name).includes(query)) return NAME_MATCH_WEIGHT;
  if (entry.tags.some((tag) => normalize(tag).includes(query))) return TAG_MATCH_WEIGHT;
  if (normalize(entry.description ?? "").includes(query)) return DESCRIPTION_MATCH_WEIGHT;
  return 0;
}

/**
 * Keeps the highest-scoring entry per normalized name — and, within a name, always prefers a
 * `"marketplace"` entry over a `"skills.sh"` one regardless of score, so what the user already
 * has never loses its place in the list to a stray skills.sh duplicate the merge step missed.
 */
function dedupeByName(ranked: readonly RankedCatalogueEntry[]): readonly RankedCatalogueEntry[] {
  const bestByName = new Map<string, RankedCatalogueEntry>();
  for (const candidate of ranked) {
    const key = normalize(candidate.entry.name);
    const current = bestByName.get(key);
    if (!current) {
      bestByName.set(key, candidate);
      continue;
    }
    const candidateWins =
      candidate.entry.source === "marketplace" && current.entry.source !== "marketplace"
        ? true
        : candidate.entry.source === current.entry.source
          ? candidate.score > current.score
          : false;
    if (candidateWins) bestByName.set(key, candidate);
  }
  return [...bestByName.values()];
}

/**
 * The one deterministic ranker (Brief 34b, level 0 — no model): tag match weighted by the
 * project's evidence count, times `log10(installs + 10)`, times an official bonus, times an
 * already-in-marketplace bonus so what the user already has ranks first for the same intent.
 * `query`, when given, filters to entries whose name/description/tags contain it and adds a
 * fixed weight on top (name match ranks above a tag-only match, which ranks above a
 * description-only match). Pure: no IO, no randomness, stable ordering (score, then name).
 */
export function rank(
  profile: StackProfile | null,
  entries: readonly CatalogueEntry[],
  query?: string,
): readonly RankedCatalogueEntry[] {
  const normalizedQuery = query?.trim() ? normalize(query) : undefined;
  const evidence = evidenceCountByTag(profile);
  const rarity = tagRarity(entries);
  const candidates = normalizedQuery ? entries.filter((entry) => textMatches(entry, normalizedQuery)) : entries;
  const scored = candidates.map((entry) => {
    const matchedTags = matchedTagsFor(entry, evidence);
    const tagFactor = profile ? tagEvidenceScore(matchedTags, evidence, rarity) + 1 : 1;
    const installsFactor = Math.log10(Math.max(entry.installs, 0) + 10);
    const officialFactor = entry.official ? OFFICIAL_BONUS : 1;
    const marketplaceFactor = entry.source === "marketplace" ? MARKETPLACE_BONUS : 1;
    const score =
      tagFactor * installsFactor * officialFactor * marketplaceFactor +
      (normalizedQuery ? queryScore(entry, normalizedQuery) : 0);
    return { entry, score, matchedTags };
  });
  return [...dedupeByName(scored)].sort(
    (left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name),
  );
}
