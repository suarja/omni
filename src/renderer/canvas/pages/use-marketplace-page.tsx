import type { ReactElement, ReactNode } from "react";
import { useI18n } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { sourcePackagePath } from "../use-owned-skill-choices";
import { activeAvailableProjectIds } from "./active-projects";
import type { PageSection } from "./PageGraph";

export function useMarketplacePage(): Readonly<{
  title: string;
  note: string;
  actions: ReactNode;
  sections: readonly PageSection[];
  error: string | null;
  loading: boolean;
  legend: ReactElement;
}> {
  const rail = useCanvasRail()!;
  const { t } = useI18n();
  const { marketplace, loading, error } = rail.personal;
  const inventory = marketplace?.inventory;
  const activeProjectIds = activeAvailableProjectIds(rail.canvas.snapshot.registry.projects);
  const sections: PageSection[] = [
    ...new Map((inventory?.packages ?? []).map((plugin) => [plugin.relativeRoot, plugin])).values(),
  ].map((plugin) => {
    const skills = (inventory?.artifacts ?? []).filter(
      (artifact) =>
        artifact.kind === "skill" &&
        (artifact.packageId === plugin.id || plugin.artifactIds.includes(artifact.id)) &&
        sourcePackagePath(plugin.relativeRoot, artifact.relativePath),
    );
    return {
      id: plugin.id,
      title: (
        <>
          {plugin.displayName} · {skills.length} {plugin.description ? <small>— {plugin.description}</small> : null}
        </>
      ),
      nodes: skills.map((skill) => {
        const path = sourcePackagePath(plugin.relativeRoot, skill.relativePath)!;
        const uses = rail.uses.filter(
          (use) =>
            !use.disabled &&
            use.source.sourceId === marketplace!.source.ref.id &&
            use.source.packageId === plugin.id &&
            use.source.artifactPath === path,
        );
        const projectIds = [...new Set(uses.map((use) => use.location.projectId))].filter((id) =>
          activeProjectIds.has(id),
        );
        return {
          id: skill.id,
          kind: "skill",
          title: path.split("/").at(-1)!,
          metadataLabels: projectIds.length
            ? projectIds.map(
                (id) =>
                  rail.canvas.snapshot.registry.projects.find((project) => project.ref.id === id)?.displayName ?? id,
              )
            : [t(rail.usesUnavailable ? "canvas.unavailable" : "externalLibrary.noProject")],
          meta: (
            <span className="external-chips">
              {projectIds.length ? (
                projectIds.map((id) => (
                  <span key={id} className="project-chip is-installed">
                    {rail.canvas.snapshot.registry.projects.find((project) => project.ref.id === id)?.displayName ?? id}
                  </span>
                ))
              ) : (
                <span className="project-chip is-absent">
                  {t(rail.usesUnavailable ? "canvas.unavailable" : "externalLibrary.noProject")}
                </span>
              )}
            </span>
          ),
          onOpen: () => rail.openMarketplaceSkill({ path: skill.relativePath, packageId: plugin.id }),
        };
      }),
    };
  });
  const remote = inventory?.marketplace?.remotePackages ?? [];
  if (remote.length)
    sections.push({
      id: "remote",
      title: (
        <>
          {t("externalLibrary.remotePlugins", { count: remote.length })}{" "}
          <small>{t("externalLibrary.remoteHint")}</small>
        </>
      ),
      nodes: remote.map((plugin) => ({
        id: plugin.locator,
        title: plugin.name,
        kind: "group",
        meta: plugin.description ?? plugin.locator,
        onOpen: rail.openPlugins,
      })),
    });
  return {
    title: marketplace
      ? t("canvas.personalMarketplace", { name: marketplace.source.displayName })
      : t("projectView.marketplace"),
    note: t("externalLibrary.marketplaceSummary", {
      plugins: sections.filter((section) => section.id !== "remote").length + remote.length,
      skills: sections.filter((section) => section.id !== "remote").reduce((n, section) => n + section.nodes.length, 0),
      visibility: t(inventory?.marketplace?.visibility === "public" ? "skillActions.public" : "skillActions.private"),
    }),
    sections,
    error: error ?? (!loading && !inventory ? t("canvas.notRead") : null),
    loading: loading && !inventory,
    actions: (
      <>
        <button
          className="canvas-secondary-button is-small"
          type="button"
          disabled={loading || Boolean(error)}
          onClick={() => rail.openNewSkill()}
        >
          {t("externalLibrary.newSkill")}
        </button>
        <button
          className="canvas-secondary-button is-small"
          data-testid="marketplace-plugins-open"
          type="button"
          onClick={rail.openPlugins}
        >
          {t("externalLibrary.pluginsStorefronts")}
        </button>
      </>
    ),
    legend: (
      <>
        <span className="project-chip is-installed">{t("externalLibrary.projectChip")}</span>
        {t("externalLibrary.installedHere")}{" "}
        <span className="project-chip is-absent">{t("externalLibrary.noProject")}</span>
        {t("externalLibrary.notInstalled")}
      </>
    ),
  };
}
