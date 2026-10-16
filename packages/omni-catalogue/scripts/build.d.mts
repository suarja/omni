// Type declarations for build.mjs's exported pure functions (Brief 34b), used only by
// tests/catalogue/build-script.test.ts — this plain-Node script has no build step of its own, so
// its types are hand-written here rather than generated.

export type LeaderboardEntry = Readonly<{
  ownerRepo: string;
  skill: string;
  name: string;
  installs: number;
  weeklyInstalls: readonly number[];
  official: boolean;
}>;

export function extractInitialSkills(html: string, minEntries?: number): LeaderboardEntry[];

export function extractSoftwareApplicationJsonLd(
  html: string,
): Readonly<{ name?: string; description?: string }> | undefined;

export function extractInstallCommand(html: string): Readonly<{ ownerRepo: string; skill: string }> | undefined;

export function candidatePaths(skill: string): string[];

export function rawUrl(ownerRepo: string, path: string): string;

export type FakeFetchResult = Readonly<{ ok: boolean }>;
export type FakeFetch = (url: string, options?: unknown) => Promise<FakeFetchResult>;

export function resolveSkillMdPath(ownerRepo: string, skill: string, fetcher?: FakeFetch): Promise<string | undefined>;

export type GitTreeEntry = Readonly<{ path: string; type: string }>;

export function findSkillMdInTree(tree: readonly GitTreeEntry[], skill: string, repoName: string): string | undefined;
