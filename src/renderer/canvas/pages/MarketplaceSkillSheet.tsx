import { LoadingSkeleton } from "../../components/ui/Skeleton";
import type { ReactElement } from "react";
import { useI18n } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { SheetFrame } from "../SheetFrame";
import { Glossary } from "../Glossary";
import { sourcePackagePath } from "../use-owned-skill-choices";
import { ChangesWorkbench } from "../changes/ChangesWorkbench";
import { projectHarnesses } from "../project-view-model";
import { InlineSkillInstall } from "./InlineSkillInstall";
import { SkillDocumentPreview } from "./SkillDocumentPreview";
import { useMarketplaceInstallPreparation } from "./use-marketplace-install-preparation";
import { activeAvailableProjectIds, isActiveAvailableProject } from "./active-projects";

export function MarketplaceSkillSheet(
  props: Readonly<{ onApplyingChange: (busy: boolean) => void }>,
): ReactElement | null {
  const rail = useCanvasRail()!;
  const { t } = useI18n();
  const marketplace = rail.personal.marketplace;
  const selected = rail.marketplaceSkill;
  const plugin = marketplace?.inventory?.packages?.find((plugin) => plugin.id === selected?.packageId);
  const artifact = marketplace?.inventory?.artifacts.find((artifact) => artifact.relativePath === selected?.path);
  const path = plugin && artifact ? sourcePackagePath(plugin.relativeRoot, artifact.relativePath) : undefined;
  const activeProjectIds = activeAvailableProjectIds(rail.canvas.snapshot.registry.projects);
  const projectIds = [
    ...new Set(
      rail.uses
        .filter(
          (use) =>
            !use.disabled &&
            use.source.sourceId === marketplace?.source.ref.id &&
            use.source.packageId === plugin?.id &&
            use.source.artifactPath === path,
        )
        .map((use) => use.location.projectId)
        .filter((id) => activeProjectIds.has(id)),
    ),
  ];
  const projects = rail.canvas.snapshot.registry.projects.filter(isActiveAvailableProject).map((project) => ({
    id: project.ref.id,
    name: project.displayName,
    available: true,
    harnesses: projectHarnesses,
  }));
  const preparation = useMarketplaceInstallPreparation({
    sourceId: marketplace?.source.ref.id,
    packageId: plugin?.id,
    artifactPath: path,
    eligibleProjectIds: projects
      .filter((project) => project.available && !rail.usesUnavailable && !projectIds.includes(project.id))
      .map((project) => project.id),
    onEnsureGrant: rail.canvas.onEnsureGrant,
  });
  const { intent, error } = preparation;
  if (!marketplace || !plugin || !artifact || !path)
    return (
      <SheetFrame
        title={
          rail.personal.loading
            ? (selected?.path.split("/").at(-1) ?? t("projectView.marketplace"))
            : t("canvas.unavailable")
        }
        kicker={t("projectView.marketplace")}
        testId="marketplace-skill-sheet"
        onClose={rail.close}
      >
        {rail.personal.loading ? (
          <LoadingSkeleton
            label={t("canvas.loadingSurface", { surface: t("projectView.marketplace") })}
            variant="document"
          />
        ) : (
          <p role="alert">{t("canvas.notRead")}</p>
        )}
      </SheetFrame>
    );
  const name = path.split("/").at(-1)!;
  if (intent)
    return (
      <ChangesWorkbench
        api={rail.canvas.api}
        initialJourney="assign"
        initialSkillIntent={intent}
        sources={[{ id: marketplace.source.ref.id, name: marketplace.source.displayName }]}
        packages={[{ id: plugin.id, name: plugin.displayName, sourceId: marketplace.source.ref.id }]}
        artifacts={[{ name, artifactPath: path, sourceId: marketplace.source.ref.id, packageId: plugin.id }]}
        projects={projects}
        onClose={rail.close}
        onBack={preparation.back}
        onSourceChanged={rail.canvas.onRefresh}
        onApplyingChange={props.onApplyingChange}
        onAdoptionChanged={rail.personal.reload}
      />
    );
  return (
    <SheetFrame
      title={name}
      kicker={
        <>
          {t("projectView.marketplace")} · {plugin.displayName} <Glossary concept="marketplace" />
        </>
      }
      subtitle={t("externalLibrary.yourSkill")}
      testId="marketplace-skill-sheet"
      className="external-library-sheet"
      onClose={rail.close}
    >
      {artifact.summary ? <p className="sh-sub">{artifact.summary}</p> : null}
      {error || rail.usesUnavailable ? <p role="alert">{error ?? t("canvas.unavailable")}</p> : null}
      <section className="external-section">
        <h3>
          {t("projectView.installedIn")} · {projectIds.length}
        </h3>
        <div className="external-rows">
          {projectIds.map((id) => (
            <div className="external-row" key={id}>
              <b>{projects.find((project) => project.id === id)?.name ?? id}</b>
              <span className="project-chip is-installed">{t("projectView.installed")}</span>
            </div>
          ))}
          {!projectIds.length ? <p>{t("externalLibrary.noProjectsYet")}</p> : null}
        </div>
      </section>
      <InlineSkillInstall
        installedProjectIds={projectIds}
        disabled={rail.usesUnavailable}
        preparing={preparation.preparing}
        onSelectionChange={preparation.select}
        onInstall={(ids) => void preparation.prepare(ids)}
      />
      <SkillDocumentPreview
        name={name}
        description={artifact.summary}
        origin={{ entry: marketplace.source.ref, path: artifact.relativePath }}
      />
    </SheetFrame>
  );
}
