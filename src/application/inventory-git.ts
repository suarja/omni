import {
  createGitScope,
  createInventoryDiagnostic,
  type GitScope,
  type InventoryDiagnostic,
} from "../domain/inventory";

type GitNormalizationHelpers = Readonly<{
  safeRelativeLocation(value: unknown, fallback: string): string;
  malformedDiagnostic(providerId: string): InventoryDiagnostic;
}>;

export function normalizeGitScopes(
  scopes: readonly GitScope[],
  helpers: GitNormalizationHelpers,
): { scopes: GitScope[]; diagnostics: InventoryDiagnostic[] } {
  const normalized: GitScope[] = [];
  const diagnostics: InventoryDiagnostic[] = [];
  const usedIds = new Set<string>();
  for (const scope of scopes) {
    try {
      const relativeRoot = helpers.safeRelativeLocation(scope.relativeRoot, "scope");
      const relativeRootWasUnsafe = helpers.safeRelativeLocation(scope.relativeRoot, "") === "";
      const requestedId = helpers.safeRelativeLocation(scope.id, "");
      const baseId = requestedId || `git-${relativeRoot}`;
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);
      const head =
        typeof scope.head === "string" && /^[0-9a-f]{4,64}$/i.test(scope.head.trim()) ? scope.head.trim() : undefined;
      normalized.push(
        createGitScope({
          id,
          relativeRoot,
          ...(head ? { head } : {}),
          ...(scope.branch ? { branch: scope.branch } : {}),
          dirty: scope.dirty,
        }),
      );
      if (relativeRootWasUnsafe) {
        diagnostics.push(
          createInventoryDiagnostic({
            location: relativeRoot,
            code: "git-unavailable",
            severity: "warning",
            message: "Git evidence could not be observed for this explicit scope.",
          }),
        );
      }
    } catch {
      diagnostics.push(helpers.malformedDiagnostic("git"));
    }
  }
  return {
    scopes: normalized.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    diagnostics,
  };
}
