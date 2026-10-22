import { WorkshopDeliverySheet } from "../delivery/WorkshopDeliverySheet";
import { MarketplaceSkillSheet } from "../pages/MarketplaceSkillSheet";
import { ExternalLibraryLayer } from "../external-library/ExternalLibraryLayer";
import { PublishSheet } from "../storefronts/PublishSheet";
import { StorefrontSheet } from "../storefronts/StorefrontSheet";
import { activeWorkshop } from "../../../domain/source-roles";
import { NewSkillSheet } from "../NewSkillSheet";
import { MyMarketplaceSheet } from "../MyMarketplaceSheet";
import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { useI18n } from "../../i18n";
import { useCanvasRail } from "./rail-context";
import { RailReviewSheet } from "./RailReviewSheet";
import { RailHistorySheet } from "./RailHistorySheet";
import { RailSettingsSheet } from "./RailSettingsSheet";
import { useWorkspaceSetup } from "../setup/use-workspace-setup";
import { createFallbackWorkspaceSetup } from "../setup/fallback-workspace-setup";
import { WorkspaceSetupSheet } from "../setup/WorkspaceSetupSheet";
import "./rail.css";
import { AnchoredFloating } from "../AnchoredFloating";

export function CanvasRailLayer(
  props: Readonly<{ busy: boolean; onApplyingChange: (active: boolean) => void }>,
): ReactElement | null {
  const rail = useCanvasRail();
  const { t } = useI18n();
  if (!rail) throw new Error("Canvas rail requires its canvas provider.");
  const { canvas } = rail;
  const fallback = useMemo(() => createFallbackWorkspaceSetup(canvas.snapshot), [canvas.snapshot]);
  const inputs = canvas.setup ?? fallback;
  const setup = useWorkspaceSetup(inputs, canvas.context);
  rail.blocked.current = props.busy || setup.state.busy;
  const menu = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rail.menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [rail.menuOpen]);
  useEffect(() => {
    if (rail.surface === "project" || rail.surface === "marketplace") setup.actions.open(rail.surface);
    else setup.actions.close();
  }, [rail.surface]);
  useEffect(() => {
    if (canvas.routeSheet || (!rail.overlayOpen && !rail.menuOpen)) return;
    const key = (event: KeyboardEvent): void => {
      const back = (event.altKey && event.key === "ArrowLeft") || (event.metaKey && event.key === "[");
      if (event.key !== "Escape" && !back) return;
      if (layer.current?.querySelector('[data-testid="page-skill-document"]')) return;
      if (event.key === "Escape" && !rail.menuOpen && document.querySelector(".canvas-pop, .canvas-menu")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (rail.menuOpen) rail.closeMenu();
      else rail.close();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [rail.surface, rail.menuOpen]);
  return (
    <>
      {rail.menuOpen ? (
        <AnchoredFloating
          anchor={document.querySelector<HTMLElement>('[data-testid="canvas-setup-menu-trigger"]')}
          kind="menu"
          label={t("rail.add")}
          className="canvas-setup-menu"
          testId="canvas-setup-menu"
          onClose={rail.closeMenu}
        >
          <div
            ref={menu}
            onKeyDown={(event) => {
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === "ArrowDown"
                  ? (index + 1) % items.length
                  : event.key === "ArrowUp"
                    ? (index + items.length - 1) % items.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                items[next]?.focus();
              }
            }}
          >
            {(["project", "marketplace", "draft"] as const).map((item) => (
              <button
                key={item}
                role="menuitem"
                aria-label={t(item === "draft" ? "rail.skill" : `rail.${item}`)}
                data-testid={`canvas-setup-add-${item}`}
                type="button"
                disabled={item !== "draft" && !canvas.setup?.api}
                onClick={() => (item === "draft" ? rail.openNewSkill() : rail.open(item))}
              >
                <span>
                  <b>{t(item === "draft" ? "rail.skill" : `rail.${item}`)}</b>
                  <small>
                    {t(
                      item === "project"
                        ? "rail.addProjectHint"
                        : item === "marketplace"
                          ? "rail.addMarketplaceHint"
                          : "rail.addSkillHint",
                    )}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </AnchoredFloating>
      ) : null}
      <div className="canvas-rail-layer" ref={layer}>
        {canvas.routeSheet}
        <ExternalLibraryLayer onApplyingChange={props.onApplyingChange} />
        {rail.surface === "review" ? (
          <RailReviewSheet onApplyingChange={props.onApplyingChange} />
        ) : rail.surface === "activity" ? (
          <RailHistorySheet />
        ) : rail.surface === "settings" ? (
          <RailSettingsSheet onApplyingChange={props.onApplyingChange} />
        ) : null}
        {rail.surface === "marketplace-skill" ? (
          <MarketplaceSkillSheet
            key={JSON.stringify([
              rail.personal.marketplace?.source.ref.id,
              rail.marketplaceSkill?.packageId,
              rail.marketplaceSkill?.path,
            ])}
            onApplyingChange={props.onApplyingChange}
          />
        ) : null}
        {rail.surface === "owned-marketplace" ? (
          <MyMarketplaceSheet
            canvas={canvas}
            onClose={rail.close}
            onNewSkill={() => rail.openNewSkill()}
            onApplyingChange={props.onApplyingChange}
          />
        ) : null}
        {rail.surface === "storefront" ? <StorefrontSheet /> : null}
        {rail.surface === "delivery" ? <WorkshopDeliverySheet onApplyingChange={props.onApplyingChange} /> : null}
        {rail.surface === "publish" ? <PublishSheet onApplyingChange={props.onApplyingChange} /> : null}
        {rail.surface === "draft" ? (
          <NewSkillSheet
            initialPackageId={rail.newSkillPackageId}
            canvas={canvas}
            onClose={rail.close}
            onApplyingChange={props.onApplyingChange}
          />
        ) : null}
        {setup.state.intent && (rail.surface === "project" || rail.surface === "marketplace") ? (
          <WorkspaceSetupSheet
            initialExternalRepository={
              rail.externalSelection.view === "add" ? rail.externalSelection.repository : undefined
            }
            setup={inputs}
            state={setup.state}
            actions={setup.actions}
            applying={props.busy || setup.state.busy}
            onApplyingChange={props.onApplyingChange}
            onClose={rail.close}
            onOpenAgents={() => rail.open("settings")}
            activePersonalSource={Boolean(activeWorkshop(canvas.snapshot.registry))}
            activeProject={canvas.snapshot.registry.projects.some((project) => !project.archivedAt)}
          />
        ) : null}
      </div>
    </>
  );
}
