import { useState, type ReactElement } from "react";
import { Icon } from "../../components/Icon";
import { tCount, useI18n } from "../../i18n";
import { useFeatures } from "../../features";
import { useCanvasRail } from "./rail-context";
import { CanvasGlyph } from "../CanvasGlyph";
import { AnchoredFloating } from "../AnchoredFloating";

export function CanvasRail(props: Readonly<{ busy: boolean }>): ReactElement | null {
  const rail = useCanvasRail();
  const { features } = useFeatures();
  const { language, t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!rail) return null;
  const count =
    rail.externalLibrary.review.length +
    rail.requests.requests.length +
    rail.maintenance.state.failures.length +
    (rail.storefronts.drift?.storefronts.reduce((count, storefront) => count + storefront.behindPlugins, 0) ?? 0);
  const button = (destination: "review" | "activity" | "settings"): ReactElement => (
    <button
      className="canvas-rail-button"
      type="button"
      key={destination}
      data-testid={`canvas-rail-${destination}`}
      aria-pressed={rail.surface === destination}
      aria-label={t(`canvas.${destination}`)}
      aria-description={destination === "review" && count ? tCount("agents.waiting", count, {}, language) : undefined}
      onClick={(event) => {
        setAnchor(null);
        event.currentTarget.focus();
        rail.open(destination);
      }}
    >
      <CanvasGlyph name={destination} size={20} />
      {destination === "review" && count ? (
        <span className="canvas-rail-badge" data-testid="canvas-review-count">
          {count}
        </span>
      ) : null}
    </button>
  );
  return (
    <aside className="canvas-rail" aria-label={t("canvas.root")} inert={props.busy}>
      <button
        className="canvas-rail-button"
        type="button"
        data-testid="canvas-rail-home"
        aria-label={t("rail.home")}
        aria-current={rail.canvas.context.kind === "workspace" && !rail.canvas.canvasPage ? "page" : undefined}
        onClick={() => {
          rail.close();
          setAnchor(null);
          rail.canvas.onNavigate({ screen: "resource-canvas", context: { kind: "workspace" } });
        }}
      >
        <CanvasGlyph name="home" size={20} />
      </button>
      <div className="canvas-rail-separator" />
      {button("review")}
      {button("activity")}
      <div className="canvas-rail-spacer" />
      {features.learn || features.publicCatalogue ? (
        <button
          className="canvas-rail-button"
          data-testid="canvas-more"
          type="button"
          aria-label={t("canvas.more")}
          aria-expanded={Boolean(anchor)}
          onClick={(event) => {
            rail.close();
            setAnchor(anchor ? null : event.currentTarget);
          }}
        >
          <Icon name="more" size={20} />
        </button>
      ) : null}
      {button("settings")}
      {anchor ? (
        <AnchoredFloating anchor={anchor} kind="menu" className="canvas-overflow" onClose={() => setAnchor(null)}>
          {features.publicCatalogue ? (
            <button
              data-testid="canvas-destination-catalogue"
              role="menuitem"
              type="button"
              onClick={() => {
                setAnchor(null);
                rail.canvas.onNavigate({ screen: "library", tab: "catalogue" });
              }}
            >
              {t("registry.catalogue")}
            </button>
          ) : null}
          {features.learn ? (
            <button
              data-testid="canvas-destination-learn"
              role="menuitem"
              type="button"
              onClick={() => {
                setAnchor(null);
                rail.canvas.onNavigateDestination("learn");
              }}
            >
              {t("canvas.learn")}
            </button>
          ) : null}
        </AnchoredFloating>
      ) : null}
    </aside>
  );
}
export function CanvasAddButton(): ReactElement | null {
  const rail = useCanvasRail();
  const { t } = useI18n();
  if (!rail) return null;
  return (
    <button
      className="canvas-secondary-button"
      data-testid="canvas-setup-menu-trigger"
      type="button"
      aria-expanded={rail.menuOpen}
      aria-haspopup="menu"
      onClick={(event) => {
        event.currentTarget.focus();
        rail.toggleMenu();
      }}
    >
      {t("rail.add")}
    </button>
  );
}
