import { useEffect, useRef, useState, type ReactElement } from "react";

import type { CatalogueEntryResponse, CatalogueEntryView, CatalogueSkillMdState } from "../../shared/catalogue-ipc";
import type { DesktopApi } from "../../shared/ipc";
import { Badge } from "../components/ui/Badge";
import { Breadcrumbs } from "../components/ui/Breadcrumbs";
import { Button } from "../components/ui/Button";
import { Callout } from "../components/ui/Callout";
import { Card, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { LoadingSkeleton } from "../components/ui/Skeleton";
import { PageHead } from "../components/ui/PageHead";
import { AssetContent } from "../assets/AssetContent";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { formatInstalls } from "./library-data";

export type CatalogueEntryPageProps = Readonly<{
  api?: Pick<DesktopApi, "getCatalogueEntry" | "prepareCatalogueImport"> | null;
  ownerRepo: string;
  projectName?: string;
  skill: string;
  onNavigateToRoute: (route: Route) => void;
  returnTo: Route;
}>;

type LoadState = "loading" | CatalogueEntryResponse;

function entryMeta(entry: CatalogueEntryView, language: "en" | "fr", t: ReturnType<typeof useI18n>["t"]): ReactElement {
  return (
    <>
      <code>{entry.ownerRepo}</code> ·{" "}
      {t("library.catalogue.installs", { count: formatInstalls(entry.installs, language) })}
      {entry.official ? ` · ${t("library.catalogue.official")}` : ""} · {t("library.catalogue.source")}
    </>
  );
}

function SkillMdCard({
  entry,
  onRetry,
  skillMd,
  t,
}: Readonly<{
  entry: CatalogueEntryView;
  onRetry: () => void;
  skillMd: CatalogueSkillMdState;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  return (
    <Card>
      <CardHeader title={t("library.catalogue.skillMdHeading")} />
      {skillMd.status === "ready" ? (
        <AssetContent content={skillMd.content} path="SKILL.md" truncated={false} />
      ) : skillMd.status === "offline" ? (
        <div className="callout-content-row">
          <span>{t("library.catalogue.offline")}</span>
          <Button dataTestId="catalogue-skillmd-retry" onClick={onRetry} size="small" tone="secondary">
            {t("registry.retry")}
          </Button>
        </div>
      ) : (
        <p>{t("library.catalogue.noSkillMd")}</p>
      )}
    </Card>
  );
}

export function CatalogueEntryPage({
  api,
  ownerRepo,
  projectName,
  skill,
  onNavigateToRoute,
  returnTo,
}: CatalogueEntryPageProps): ReactElement {
  const { language, t } = useI18n();
  const [state, setState] = useState<LoadState>("loading");
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const previousEntry = useRef<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const key = JSON.stringify([ownerRepo, skill]);
    if (previousEntry.current !== key) setState("loading");
    previousEntry.current = key;
    if (!api?.getCatalogueEntry) return;
    void api
      .getCatalogueEntry({ ownerRepo, skill })
      .then((response) => {
        if (active) setState(response);
      })
      .catch(() => {
        if (active) setState({ status: "not-found" });
      });
    return () => {
      active = false;
    };
  }, [api, ownerRepo, skill, reloadToken]);

  const addToMarketplace = async (): Promise<void> => {
    if (!api?.prepareCatalogueImport) return;
    setPreparing(true);
    setPrepareError(null);
    try {
      const result = await api.prepareCatalogueImport({ ownerRepo, skill });
      if (result.status !== "ready") {
        setPrepareError(
          result.status === "offline" ? t("library.catalogue.offline") : t("library.catalogue.prepareFailed"),
        );
        return;
      }
      const entry = state !== "loading" && state.status === "ready" ? state.entry : undefined;
      onNavigateToRoute({
        screen: "operation-import-catalogue",
        ownerRepo,
        skill,
        sourceId: result.sourceId,
        grantHandle: result.grantHandle,
        relativePath: result.relativePath,
        name: entry?.name ?? skill,
        ...(entry?.description ? { description: entry.description } : {}),
        returnTo: { screen: "catalogue-entry", ownerRepo, skill, returnTo },
      });
    } catch {
      setPrepareError(t("library.catalogue.prepareFailed"));
    } finally {
      setPreparing(false);
    }
  };

  const projectOrigin = returnTo.screen === "project" ? returnTo : null;

  const breadcrumbs = (
    <Breadcrumbs
      items={
        projectOrigin
          ? [
              { label: t("registry.projectsHeading"), onClick: () => onNavigateToRoute({ screen: "projects" }) },
              {
                label: projectName ?? projectOrigin.projectId,
                onClick: () =>
                  onNavigateToRoute({ screen: "project", projectId: projectOrigin.projectId, tab: "overview" }),
              },
              { label: skill },
            ]
          : [
              {
                label: t("library.heading"),
                onClick: () => onNavigateToRoute({ screen: "library", tab: "catalogue" }),
              },
              {
                label: t("library.catalogue.tab"),
                onClick: () => onNavigateToRoute({ screen: "library", tab: "catalogue" }),
              },
              { label: skill },
            ]
      }
    />
  );

  if (state === "loading")
    return (
      <div className="shell-page destination-page" data-testid="catalogue-entry-page">
        {breadcrumbs}
        <PageHead title={skill} />
        <ItemList>
          <LoadingSkeleton label={t("canvas.loadingSurface", { surface: t("canvas.library") })} />
        </ItemList>
      </div>
    );

  if (state.status === "not-found")
    return (
      <div className="shell-page destination-page" data-testid="catalogue-entry-page">
        {breadcrumbs}
        <EmptyState description={t("library.catalogue.noMatches")} title={t("library.catalogue.noMatches")} />
      </div>
    );

  const { entry, skillMd } = state;
  return (
    <div className="shell-page destination-page" data-testid="catalogue-entry-page">
      {breadcrumbs}
      <PageHead
        actions={
          <>
            {projectOrigin ? (
              <Button
                dataTestId="catalogue-add-to-project"
                onClick={() =>
                  onNavigateToRoute({
                    screen: "add-to-project",
                    ownerRepo,
                    skill,
                    projectId: projectOrigin.projectId,
                    returnTo,
                  })
                }
              >
                {t("library.catalogue.addToProject", { project: projectName ?? projectOrigin.projectId })}
              </Button>
            ) : null}
            <Button
              dataTestId="catalogue-add-to-marketplace"
              disabled={preparing}
              onClick={() => void addToMarketplace()}
              tone={projectOrigin ? "ghost" : undefined}
            >
              {t("library.catalogue.addToMarketplace")}
            </Button>
          </>
        }
        badges={
          entry.source === "marketplace" ? (
            <Badge dotTone="ok" tone="ok" variant="status">
              {t("library.catalogue.installedBadge")}
            </Badge>
          ) : null
        }
        description={entry.description}
        meta={entryMeta(entry, language, t)}
        title={entry.name}
      />
      {prepareError ? (
        <Callout title={t("operations.failed")} tone="error">
          {prepareError}
        </Callout>
      ) : null}
      <SkillMdCard entry={entry} onRetry={() => setReloadToken((token) => token + 1)} skillMd={skillMd} t={t} />
    </div>
  );
}
