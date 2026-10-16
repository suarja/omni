export const publicationClassifications = [
  "unchanged",
  "workshop-changed",
  "storefront-only",
  "conflict",
  "added-in-workshop",
  "removed-in-workshop",
] as const;
export type PublicationClassification = (typeof publicationClassifications)[number];
export type PublicationFileDrift = Readonly<{ path: string; classification: PublicationClassification }>;
export type PublicationCounts = Readonly<Record<PublicationClassification, number>>;
export type PublicationDrift = Readonly<{
  files: readonly PublicationFileDrift[];
  counts: PublicationCounts;
  behind: boolean;
  toPublish: number;
  conflicts: number;
}>;
type Hashes = Readonly<Record<string, string>>;

export function emptyPublicationCounts(): Record<PublicationClassification, number> {
  return {
    unchanged: 0,
    "workshop-changed": 0,
    "storefront-only": 0,
    conflict: 0,
    "added-in-workshop": 0,
    "removed-in-workshop": 0,
  };
}

function classifyFile(
  base: string | undefined,
  storefront: string | undefined,
  workshop: string | undefined,
): PublicationClassification {
  if (workshop === storefront) return "unchanged";
  if (workshop === base) return "storefront-only";
  if (storefront !== base) return "conflict";
  if (base === undefined) return "added-in-workshop";
  if (workshop === undefined) return "removed-in-workshop";
  return "workshop-changed";
}

export function classifyPublicationDrift(base: Hashes, storefront: Hashes, workshop: Hashes): PublicationDrift {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(storefront), ...Object.keys(workshop)])]
    .filter((path) => path !== "omni.plugin.json")
    .sort();
  const ownHash = (hashes: Hashes, path: string): string | undefined =>
    Object.hasOwn(hashes, path) ? hashes[path] : undefined;
  const files = paths.map((path) => ({
    path,
    classification: classifyFile(ownHash(base, path), ownHash(storefront, path), ownHash(workshop, path)),
  }));
  const counts = emptyPublicationCounts();
  for (const file of files) counts[file.classification] += 1;
  const toPublish = counts["workshop-changed"] + counts["added-in-workshop"] + counts["removed-in-workshop"];
  return { files, counts, behind: toPublish > 0 || counts.conflict > 0, toPublish, conflicts: counts.conflict };
}
