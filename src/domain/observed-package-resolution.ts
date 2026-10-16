import type { ObservedPackage } from "./inventory";

export type PackageResolutionBlock = Readonly<{
  status: "blocked";
  code: "package-not-found" | "package-ambiguous";
  message: string;
}>;

export type ObservedPackageResolution =
  Readonly<{ status: "resolved"; package: ObservedPackage }> | PackageResolutionBlock;

export function resolveObservedPackage(
  packages: readonly ObservedPackage[],
  requestedId: string,
): ObservedPackageResolution {
  const exact = packages.filter((candidate) => candidate.id === requestedId);
  const matches = exact.length
    ? exact
    : packages.filter(
        (candidate) =>
          candidate.relativeRoot === requestedId ||
          candidate.relativeRoot === `packages/${requestedId}` ||
          candidate.id === `packages/${requestedId}` ||
          candidate.displayName === requestedId ||
          candidate.manifestId === requestedId,
      );
  if (matches.length === 1) return { status: "resolved", package: matches[0]! };
  const ids = [...new Set(packages.map(({ id }) => id))];
  const validIds = ids.slice(0, 20).join(", ") || "none";
  return {
    status: "blocked",
    code: matches.length ? "package-ambiguous" : "package-not-found",
    message: `Package "${requestedId}" ${matches.length ? "is ambiguous" : "was not found"}. Valid package ids: ${validIds}${ids.length > 20 ? ", …" : ""}. Retry with an exact observed package id.`,
  };
}
