import { useSourceRepository } from "./use-source-repository";
import { buildLibrarySections, buildSourceSections } from "./external-page-sections";
import { type ReactElement, type ReactNode } from "react";
import { useI18n, translateCount, type TranslationFunction } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { useMacDiscovery } from "../external-library/use-mac-discovery";
import {
  formatCheckTime,
  formatPassTime,
  formatSourceDate,
  licenceLabel,
  needsComparison,
} from "../external-library/presentation";
import { Glossary } from "../Glossary";
import { LibraryPassBanner, SourcePageBanner } from "./LibraryPassBanner";
import type { PageSection } from "./PageGraph";
import { activeAvailableProjectIds } from "./active-projects";

function formatLibraryCheck(value: string | undefined, t: TranslationFunction, language: string): string {
  if (!value) return t("externalLibrary.notChecked");
  if (new Date(value).toDateString() === new Date().toDateString())
    return t("externalLibrary.checkedToday", { time: formatCheckTime(value, language) });
  const time = formatPassTime(value, t, language);
  return t("externalLibrary.checkedAt", { time: time[0]!.toLocaleLowerCase(language) + time.slice(1) });
}

export function useExternalPage(sourceId?: string): Readonly<{
  title: string;
  note: string;
  actions: ReactNode;
  sections: readonly PageSection[];
  banner: ReactNode;
  error: string | null;
  loading: boolean;
  legend: ReactElement;
}> {
  const rail = useCanvasRail()!;
  const { t, language } = useI18n();
  const library = rail.externalLibrary;
  const macDetails = useMacDiscovery(rail.canvas.api, library.mac);
  const repository = useSourceRepository(rail.canvas.api, sourceId);
  const sources = library.list?.sources ?? [];
  const activeProjectIds = activeAvailableProjectIds(rail.canvas.snapshot.registry.projects);
  const details = sourceId ? library.details.get(sourceId) : undefined;
  const source = details?.source;
  const uses = [...library.details.values()]
    .flatMap((item) => item.uses)
    .filter((use) => activeProjectIds.has(use.projectId));
  let banner: ReactNode = null;
  let note = `${translateCount(t, "externalLibrary.sourceCount", sources.length)} · ${formatLibraryCheck(library.list?.lastPass?.finishedAt, t, language)}`;
  let actions: ReactNode = (
    <>
      <button
        type="button"
        className="canvas-secondary-button is-small"
        disabled={library.checking || !rail.canvas.api?.checkExternalLibrary}
        onClick={() => void library.check()}
      >
        {t(library.checking ? "externalLibrary.checking" : "externalLibrary.check")}
      </button>
      <button
        type="button"
        className="canvas-secondary-button is-small is-primary"
        onClick={() => rail.openExternalDestination({ view: "add" })}
      >
        {t("externalLibrary.addSource")}
      </button>
    </>
  );
  const sections = sourceId
    ? buildSourceSections(details, rail.openExternalContext, t, activeProjectIds)
    : buildLibrarySections(
        {
          library,
          t,
          open: rail.openExternalDestination,
          openSkill: rail.openExternalContext,
          personalMarketplaceName: rail.personal.marketplace?.inventory?.marketplace?.name,
          activeProjectIds,
        },
        macDetails,
      );
  const hasLibraryBanner =
    (library.list?.lastPass?.updates?.some((item) => item.copiesUpdated > 0) ?? false) ||
    uses.some(needsComparison) ||
    (library.mode === "ask" && uses.some((use) => use.state === "update"));
  if (!sourceId && hasLibraryBanner) banner = <LibraryPassBanner />;
  if (sourceId && source && details) {
    note = `${licenceLabel(source.licence, t)} · ${translateCount(t, "externalLibrary.skillCount", source.skillCount)} · ${t("externalLibrary.sourceVersion", { version: source.head?.commit.slice(0, 7) ?? "—", date: formatSourceDate(source.head?.date, language) })} · ${t("externalLibrary.readOnly")}`;
    actions = (
      <button
        type="button"
        className="canvas-secondary-button is-small"
        disabled={!source.repo || !rail.canvas.api?.openExternalSourceRepository}
        onClick={() => void repository.open()}
      >
        {t("externalLibrary.openGithub")}
      </button>
    );
    const sourceUses = uses.filter((use) => use.sourceId === sourceId);
    if (sourceUses.some(needsComparison) || !sourceUses.length) banner = <SourcePageBanner sourceId={sourceId} />;
  }
  const failure =
    repository.error ??
    (source?.lastError
      ? t("externalLibrary.offline", { reason: source.lastError.message })
      : (library.error ??
        library.list?.diagnostics[0]?.message ??
        (sourceId && !library.loading && !source
          ? t("externalLibrary.unknown")
          : (library.mac?.error?.message ?? null))));
  return {
    title: sourceId ? (source?.name ?? sourceId) : t("externalLibrary.library"),
    note,
    sections,
    banner,
    actions,
    error: failure,
    loading: library.loading && !library.list,
    legend: (
      <>
        <span className="project-chip is-installed">{t("externalLibrary.projectChip")}</span>
        {t("externalLibrary.installedHere")}{" "}
        <span className="project-chip is-current">{t("externalLibrary.current")}</span>
        <span className="project-chip is-update">{t("externalLibrary.update")}</span>
        <span className="project-chip is-removed">{t("externalLibrary.removed")}</span>
      </>
    ),
  };
}
