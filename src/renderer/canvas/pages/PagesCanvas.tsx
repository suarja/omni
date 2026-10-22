import { AppUpdateRestartControl } from "../../settings/AppUpdateRestartControl";
import { LoadingBoundary } from "../../components/ui/Skeleton";
import { SavedPageOperation } from "./SavedPageOperation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createResourceCatalogue } from "../../../domain/resource-catalogue";
import type { ResourceCanvasProps } from "../resource-canvas-types";
import { useCanvasRail } from "../rail/rail-context";
import { CanvasRail, CanvasAddButton } from "../rail/RailControls";
import { CanvasRailLayer } from "../rail/CanvasRailLayer";
import { CanvasSearch } from "../CanvasSearch";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n";
import { Glossary } from "../Glossary";
import { CanvasViewport } from "../spatial/CanvasViewport";
import { useCanvasCamera } from "../spatial/use-canvas-camera";
import { useEmptyCanvasPress } from "../use-empty-canvas-press";
import { PageGraph, layoutPageSections, type PageSection } from "./PageGraph";
import { routeForCanvasPage } from "./page-navigation";
import { useExternalPage } from "./use-external-page";
import { useMarketplacePage } from "./use-marketplace-page";
import "../canvas.css";
import "../project-view.css";
import "../external-library/external-library.css";
import "./pages.css";

type Model = Readonly<{
  title: string;
  note: string;
  actions: ReactNode;
  sections: readonly PageSection[];
  banner?: ReactNode;
  error: string | null;
  loading: boolean;
  legend: ReactNode;
}>;
function PageCanvas(props: ResourceCanvasProps & Readonly<{ model: Model }>): ReactElement {
  const rail = useCanvasRail()!;
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const overlayOpen = Boolean(props.routeSheet || props.initialSkillResultId || props.initialSkillRestoreOperationId);
  const [search, setSearch] = useState(false);
  const [help, setHelp] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const page = props.canvasPage!;
  const key = JSON.stringify(page);
  const model = props.model;
  const [bannerHeight, setBannerHeight] = useState(0);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const measure = useCallback((next: ReadonlyMap<string, number>): void => {
    setHeights((current) =>
      next.size === current.size && [...next].every(([id, height]) => current.get(id) === height) ? current : next,
    );
  }, []);
  const graph = useMemo(
    () =>
      layoutPageSections(
        model.sections,
        model.banner ? Math.max(128, 62 + bannerHeight + 24) : 70,
        page.kind === "marketplace" ? 22 : 18,
        heights,
      ),
    [model.sections, model.banner, page.kind, heights, bannerHeight],
  );
  const camera = useCanvasCamera({
    viewportRef,
    viewKey: key,
    layout: graph.layout,
    layoutForSize: () => graph.layout,
    initialCamera: props.session?.read(key)?.cameras[key] ?? { x: 0, y: 0, scale: 1 },
    resizeAnchor: "origin",
    disabled: busy,
    onCameraChange: (next) => props.session?.write(key, { groupId: null, cameras: { [key]: next } }),
  });
  const emptyPress = useEmptyCanvasPress(() => {
    rail.close();
    setSearch(false);
  }, busy);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent): void => {
      if (busy) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        rail.close();
        setSearch(true);
      }
      if (!rail.surface && ((event.altKey && event.key === "ArrowLeft") || (event.metaKey && event.key === "["))) {
        event.preventDefault();
        props.onBack?.();
      }
      if (!rail.surface && ((event.altKey && event.key === "ArrowRight") || (event.metaKey && event.key === "]"))) {
        event.preventDefault();
        props.onForward?.();
      }
      if (event.key === "Escape") setSearch(false);
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [busy, rail.surface, props.onBack, props.onForward]);
  const records = useMemo(() => createResourceCatalogue(props.snapshot).search(""), [props.snapshot]);
  return (
    <div
      className={`resource-canvas${help ? " is-help-mode" : ""}`}
      data-theme="light"
      data-testid="resource-canvas"
      aria-busy={busy}
    >
      <CanvasRail busy={busy || overlayOpen} />
      <header className="canvas-header" inert={busy || overlayOpen}>
        <nav className="canvas-breadcrumbs" aria-label={t("canvas.breadcrumbs")}>
          <button
            type="button"
            onClick={() => props.onNavigate({ screen: "resource-canvas", context: { kind: "workspace" } })}
          >
            {t("canvas.workspace")}
          </button>
          <span>/</span>
          <button
            type="button"
            onClick={() =>
              props.onNavigate(routeForCanvasPage({ kind: page.kind === "marketplace" ? "marketplace" : "library" }))
            }
          >
            {t(page.kind === "marketplace" ? "projectView.marketplace" : "externalLibrary.library")}
          </button>
          {page.kind === "source" ? (
            <>
              <span>/</span>
              <span>{model.title}</span>
            </>
          ) : null}
        </nav>
        <div className="canvas-header-actions">
          <button
            className="canvas-search-trigger"
            type="button"
            onClick={() => {
              rail.close();
              setSearch(true);
            }}
          >
            <Icon name="search" size={16} />
            <span>{t("canvas.search")}</span>
            <kbd>⌘K</kbd>
          </button>
          <CanvasAddButton />
          <button className="canvas-secondary-button" type="button" aria-pressed={help} onClick={() => setHelp(!help)}>
            {t("projectView.help")}
          </button>
          <AppUpdateRestartControl api={props.railServices?.api ?? props.api} />
        </div>
      </header>
      <main
        {...emptyPress}
        className="canvas-stage"
        data-testid={
          page.kind === "marketplace"
            ? "marketplace-page"
            : page.kind === "library"
              ? "external-library-page"
              : "external-source-page"
        }
        inert={busy || overlayOpen}
      >
        <div className="project-stage-heading page-stage-heading">
          <strong className="stage-title">{model.title}</strong>
          <Glossary concept={page.kind === "marketplace" ? "marketplace" : "library"} />
          <span className="stage-note">{model.loading ? null : model.note}</span>
          <div className="page-head-actions">{model.actions}</div>
        </div>
        <CanvasViewport viewportRef={viewportRef} controls={camera} disabled={busy}>
          <LoadingBoundary
            key={key}
            loading={model.loading}
            label={t("canvas.loadingSurface", { surface: model.title })}
            variant="cards"
            minHeight={300}
          >
            <PageGraph
              sections={model.sections}
              tops={graph.tops}
              nodeTops={graph.nodeTops}
              onMeasure={measure}
              onBannerMeasure={setBannerHeight}
              height={graph.layout.bounds.bottom}
              banner={model.banner}
            />
          </LoadingBoundary>
        </CanvasViewport>

        {model.error ? (
          <p className="page-status external-error" role="alert">
            {model.error}
          </p>
        ) : null}
        <div className="project-legend">{model.legend}</div>
      </main>
      {search ? (
        <CanvasSearch
          records={records}
          onClose={() => setSearch(false)}
          onSelect={(resource) => {
            setSearch(false);
            props.onNavigate({ screen: "resource-canvas", context: resource.ref });
          }}
        />
      ) : null}
      <SavedPageOperation {...props} onApplyingChange={setBusy} />
      <CanvasRailLayer busy={busy || overlayOpen} onApplyingChange={setBusy} />
    </div>
  );
}
function MarketplaceCanvas(props: ResourceCanvasProps): ReactElement {
  return <PageCanvas {...props} model={useMarketplacePage()} />;
}
function ExternalCanvas(props: ResourceCanvasProps): ReactElement {
  return (
    <PageCanvas
      {...props}
      model={useExternalPage(props.canvasPage?.kind === "source" ? props.canvasPage.sourceId : undefined)}
    />
  );
}
export function PagesCanvas(props: ResourceCanvasProps): ReactElement {
  return props.canvasPage?.kind === "marketplace" ? <MarketplaceCanvas {...props} /> : <ExternalCanvas {...props} />;
}
