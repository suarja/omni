export type SourceRole = "workshop" | "storefront";
type RoleSource = Readonly<{ ownership: "personal" | "external"; role?: SourceRole; archivedAt?: string }>;
type Sources<T extends RoleSource> = Readonly<{ sources: readonly T[] }>;

export function isWorkshopSource<T extends RoleSource>(
  source: T | undefined,
): source is T & { ownership: "personal"; role?: "workshop"; archivedAt?: undefined } {
  return source?.ownership === "personal" && source.role !== "storefront" && source.archivedAt === undefined;
}

export function activeWorkshop<T extends RoleSource>(registry: Sources<T>): T | undefined {
  return registry.sources.find(isWorkshopSource);
}

export function activeStorefronts<T extends RoleSource>(registry: Sources<T>): readonly T[] {
  return registry.sources.filter(
    (source) => source.ownership === "personal" && source.role === "storefront" && source.archivedAt === undefined,
  );
}

export class StorefrontTargetError extends Error {
  readonly code = "storefront-target";
  constructor() {
    super("A storefront cannot be a skill destination. Select the active workshop.");
    this.name = "StorefrontTargetError";
  }
}

export function assertWorkshopTarget(
  source: Readonly<{ role?: SourceRole; ownership?: "personal" | "external" }>,
): void {
  if (source.role === "storefront") throw new StorefrontTargetError();
}

export function parseSourceRole(ownership: "personal" | "external", role: unknown): SourceRole | undefined {
  if (role === undefined) return undefined;
  if (ownership !== "personal" || (role !== "workshop" && role !== "storefront"))
    throw new Error("Source role is invalid.");
  return role;
}
