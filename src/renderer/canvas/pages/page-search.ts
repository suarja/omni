import type { ResourceRecord } from "../../../domain/resource-catalogue";
import type { Route } from "../../navigation";
import { useI18n } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { sourcePackagePath } from "../use-owned-skill-choices";
import { routeForCanvasPage, routeForExternal } from "./page-navigation";
import { externalSkillTargets, externalSkillTitle, resolveExternalSkill } from "./external-skill-selection";

export type CanvasSearchChoice = Readonly<{
  key: string;
  label: string;
  hint: string;
  kind: ResourceRecord["kind"];
  resource?: ResourceRecord;
  route?: Route;
}>;
export function usePageSearchChoices(): readonly CanvasSearchChoice[] {
  const rail = useCanvasRail();
  const { t } = useI18n();
  if (!rail) return [];
  const result: CanvasSearchChoice[] = [
    {
      key: "page:marketplace",
      label: t("projectView.marketplace"),
      hint: rail.personal.marketplace?.source.displayName ?? "",
      kind: "marketplace",
      route: routeForCanvasPage({ kind: "marketplace" }),
    },
    {
      key: "page:library",
      label: t("externalLibrary.library"),
      hint: t("externalLibrary.sources"),
      kind: "external-source",
      route: routeForCanvasPage({ kind: "library" }),
    },
  ];
  for (const details of rail.externalLibrary.details.values()) {
    if (!details.source) continue;
    const sourceId = details.source.id;
    result.push({
      key: `source:${sourceId}`,
      label: details.source.name,
      hint: t("externalLibrary.library"),
      kind: "external-source",
      route: routeForCanvasPage({ kind: "source", sourceId }),
    });
    for (const target of externalSkillTargets(details))
      result.push({
        key: `external:${JSON.stringify([sourceId, target.skillName, target.skillPath, target.useId])}`,
        label: externalSkillTitle(details, target),
        hint: `${details.source.name} · ${resolveExternalSkill(details, target).skill?.description ?? t("externalLibrary.removed")}`,
        kind: "artifact",
        route: routeForExternal({ sourceId, ...target, view: "skill" }),
      });
  }
  const marketplace = rail.personal.marketplace;
  for (const plugin of marketplace?.inventory?.packages ?? []) {
    for (const artifact of marketplace?.inventory?.artifacts ?? []) {
      if (artifact.kind !== "skill" || (artifact.packageId !== plugin.id && !plugin.artifactIds.includes(artifact.id)))
        continue;
      const path = sourcePackagePath(plugin.relativeRoot, artifact.relativePath);
      if (!path) continue;
      result.push({
        key: `personal:${artifact.id}`,
        label: path.split("/").at(-1)!,
        hint: `${t("projectView.marketplace")} · ${plugin.displayName} · ${artifact.relativePath} · ${artifact.summary ?? ""}`,
        kind: "artifact",
        route: {
          ...routeForCanvasPage({ kind: "marketplace" }),
          initialMarketplaceSkill: { packageId: plugin.id, path: artifact.relativePath },
        },
      });
    }
  }
  return result;
}
