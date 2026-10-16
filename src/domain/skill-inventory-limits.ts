import { dirname, relative } from "node:path";
import type {
  AgentSkillInventoryResponse,
  SkillInventoryIdentity,
  SkillInventoryReadUnit,
  SkillInventoryScope,
  SkillInventorySnapshot,
  SkillInventoryUnit,
  SkillInventoryPublicLimit,
} from "../shared/skill-inventory";

const MAX_RESPONSE_CHARACTERS = 20_000;

export function compactSkillInventoryUnit(
  unit: SkillInventoryReadUnit,
  scope: SkillInventoryScope,
): SkillInventoryUnit {
  const path = relative(scope.root, unit.skillMdPath).replaceAll("\\", "/");
  if (path.startsWith("../") || path === ".." || path.startsWith("/"))
    throw new Error(`Inventory unit ${unit.id} is outside scope ${scope.key}; reopen that root.`);
  const locations = unit.locations.filter((location) => location.folder !== dirname(path) || location.linkTo);
  const origin = unit.origin.kind === "local" || scope.kind === "marketplace" ? undefined : unit.origin;
  return {
    id: unit.id,
    name: unit.name,
    scope: scope.key,
    path,
    ...(unit.contentHash ? { hash: unit.contentHash.slice(0, 12) } : {}),
    ...(unit.packageId ? { packageId: unit.packageId } : {}),
    ...(locations.length ? { locations } : {}),
    ...(origin ? { origin } : {}),
    ...(unit.description ? { description: unit.description.slice(0, 160) } : {}),
    ...(unit.lines === null ? {} : { lines: unit.lines }),
    ...(unit.files === null || unit.files === 1 ? {} : { files: unit.files }),
  };
}
export function compactSkillInventoryIdentity(identity: SkillInventoryIdentity): SkillInventoryIdentity {
  return {
    ...identity,
    sameContentDifferentNames: identity.sameContentDifferentNames.map((finding) => ({
      ...finding,
      contentHash: finding.contentHash.slice(0, 12),
    })),
    byName: identity.byName.map((finding) => ({
      ...finding,
      hashes: Object.fromEntries(Object.entries(finding.hashes).map(([id, hash]) => [id, hash.slice(0, 12)])),
    })),
  };
}

// Only description caps are repetitive diagnostics. Safety limits retain every affected path.
function compactLimits(limits: SkillInventorySnapshot["limits"]): readonly SkillInventoryPublicLimit[] {
  const descriptions = limits.filter((limit) => limit.reason === "description-capped-at-160");
  return [
    ...limits.filter((limit) => limit.reason !== "description-capped-at-160"),
    ...(descriptions.length
      ? [
          {
            reason: "description-capped-at-160" as const,
            count: descriptions.length,
            examples: descriptions.slice(0, 3).map(({ scope, path }) => ({ scope, path })),
          },
        ]
      : []),
  ];
}

/** Never truncate evidence. A metadata-only page that cannot fit requires a narrower scope. */
export function readSkillInventoryPage(
  snapshot: SkillInventorySnapshot,
  offset: number,
  cursorAt: (offset: number) => string,
): AgentSkillInventoryResponse {
  if (!Number.isInteger(offset) || offset < 0 || offset > snapshot.units.length)
    throw new Error("Inventory cursor position is invalid; restart the inventory.");
  const response = (end: number): AgentSkillInventoryResponse => ({
    units: snapshot.units.slice(offset, end),
    ...(offset === 0
      ? {
          status: snapshot.status,
          scopes: snapshot.scopes,
          identity: snapshot.identity,
          limits: compactLimits(snapshot.limits),
          ...(snapshot.unavailable.length ? { unavailable: snapshot.unavailable } : {}),
        }
      : {}),
    ...(end < snapshot.units.length ? { nextCursor: cursorAt(end) } : {}),
  });
  let low = offset;
  let high = snapshot.units.length;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (JSON.stringify(response(end)).length < MAX_RESPONSE_CHARACTERS) low = end;
    else high = end - 1;
  }
  const page = response(low);
  if (JSON.stringify(page).length >= MAX_RESPONSE_CHARACTERS || (low === offset && offset < snapshot.units.length))
    throw new Error(
      "Inventory evidence exceeds the 20000-character page budget; select fewer projects or the marketplace alone.",
    );
  return page;
}
