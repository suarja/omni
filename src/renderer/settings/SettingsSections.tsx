import { LoadingBoundary, LoadingSkeleton } from "../components/ui/Skeleton";
import { AppUpdateRow } from "./AppUpdateRow";
import { translateCount } from "../i18n";
import { StorefrontSettingsRows } from "../canvas/storefronts/StorefrontSettingsRows";
import type { ReactElement } from "react";
import { version } from "../../../package.json";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { useI18n } from "../i18n";
import type { DesktopApi } from "../../shared/ipc";
import type { Route } from "../navigation";
import { AgentsCard } from "./AgentsCard";
import { AiCard } from "./AiCard";
import { FeaturesCard } from "./FeaturesCard";
import { Glossary } from "../canvas/Glossary";
import { LoginItemRow } from "./LoginItemRow";
import { useSheetSettings } from "./use-sheet-settings";
import "./sheet-settings.css";
import { useCanvasRail } from "../canvas/rail/rail-context";
export type SettingsSectionsProps = Readonly<{
  api?: DesktopApi | null;
  onNavigateToRoute?: (route: Route) => void;
  marketplace?: Readonly<{ name: string; path: string }>;
  onOpenMarketplace?: () => void;
  onAgentApplyingChange?: (active: boolean) => void;
}>;
export function SettingsSections({
  api = null,
  onNavigateToRoute,
  marketplace,
  onOpenMarketplace,
  onAgentApplyingChange,
}: SettingsSectionsProps): ReactElement {
  const { language, setLanguage, t } = useI18n();
  const state = useSheetSettings(api);
  const rail = useCanvasRail();
  const marketplacePath =
    state.paths.marketplace ??
    (marketplace?.path.startsWith("~") || marketplace?.path.startsWith("/") ? marketplace.path : undefined);
  const approvals = ["personalMarketplace", "projects"] as const;
  return (
    <section
      aria-label={t("settings.sectionAriaLabel")}
      className="settings-page settings-page--sheet"
      data-testid="settings-page"
    >
      <div className="settings-groups">
        <AgentsCard
          api={api}
          status={state.status}
          loaded={state.loaded}
          onChanged={state.refreshStatus}
          onApplyingChange={onAgentApplyingChange}
          maintenance={rail?.maintenance.state}
        />
        <section className="sec settings-approval">
          <h3>
            {t("uxSettings.approval")} <Glossary concept="approval" />
          </h3>
          <LoadingBoundary
            loading={!state.settingsLoaded}
            label={t("canvas.loadingSurface", { surface: t("canvas.settings") })}
            variant="settings"
            minHeight={224}
          >
            {approvals.map((target) => (
              <div className="item" key={target}>
                <div className="grow">
                  <b>{t(target === "personalMarketplace" ? "uxSettings.myMarketplace" : "uxSettings.myProjects")}</b>
                  <small>
                    {t(
                      target === "personalMarketplace" ? "uxSettings.marketplaceChanges" : "uxSettings.projectChanges",
                    )}
                  </small>
                </div>
                <SegmentedControl
                  ariaLabel={t(`settings.agents.approval.${target}.ariaLabel`)}
                  options={[
                    { label: t("settings.agents.approval.conversation"), value: "conversation" },
                    { label: t("settings.agents.approval.omni"), value: "omni" },
                  ]}
                  value={target === "personalMarketplace" ? state.personalApproval : state.projectsApproval}
                  onValueChange={(value) => state.saveApproval(target, value)}
                />
              </div>
            ))}
            <div className="item">
              <div className="grow">
                <b>{t("storefronts.myStorefronts")}</b>
                <small>{t("storefronts.publicReason")}</small>
              </div>
              <span className="storefront-approval-tag">{t("storefronts.alwaysOmni")}</span>
            </div>
            <span className="hint">{t("uxSettings.approvalHint")}</span>
          </LoadingBoundary>
        </section>
        <section className="sec settings-git">
          <h3>{t("rail.marketplace")}</h3>
          <LoadingBoundary
            loading={!state.settingsLoaded}
            label={t("canvas.loadingSurface", { surface: t("canvas.settings") })}
            variant="settings"
            minHeight={260}
          >
            <div className="item">
              <div className="grow">
                <b>{marketplace?.name ?? t("uxSettings.myMarketplace")}</b>
                <small>
                  {!state.pathsLoaded && !marketplacePath ? (
                    <LoadingSkeleton
                      label={t("canvas.loadingSurface", { surface: t("canvas.settings") })}
                      variant="inline"
                    />
                  ) : (
                    (marketplacePath ?? t(marketplace ? "canvas.notRead" : "settings.paths.none"))
                  )}
                </small>
              </div>
              <button
                className="canvas-secondary-button is-small"
                type="button"
                disabled={!onOpenMarketplace}
                onClick={onOpenMarketplace}
              >
                {t("rail.open")}
              </button>
            </div>
            <div className="item" data-testid="external-library-settings">
              <div className="grow">
                <b>
                  {t("externalLibrary.library")} ·{" "}
                  {
                    translateCount(
                      t,
                      "externalLibrary.followed",
                      rail?.externalLibrary.list?.sources.length ?? 0,
                    ).split(" · ")[0]
                  }
                </b>
                <small>
                  {t(
                    state.externalLibraryUpdates === "auto"
                      ? "externalLibrary.autoSetting"
                      : "externalLibrary.askSetting",
                  )}
                </small>
              </div>
              <SegmentedControl
                ariaLabel={t("externalLibrary.library")}
                value={state.externalLibraryUpdates}
                options={[
                  { label: t("externalLibrary.auto"), value: "auto", disabled: !api?.setSettings },
                  { label: t("externalLibrary.ask"), value: "ask", disabled: !api?.setSettings },
                ]}
                onValueChange={(updates) =>
                  state.saveExternalLibrary(updates, () => {
                    void rail?.externalLibrary.reload();
                  })
                }
              />
              <button
                type="button"
                className="canvas-secondary-button is-small"
                disabled={!rail}
                onClick={() => rail?.openExternalDestination()}
              >
                {t("externalLibrary.open")}
              </button>
            </div>
            <StorefrontSettingsRows />
            <div className="item">
              <div className="grow">
                <b>{t("uxSettings.commit")}</b>
                <small>{t("uxSettings.noPush")}</small>
              </div>
              <span data-testid="settings-git-control">
                <button
                  className="canvas-switch"
                  type="button"
                  role="switch"
                  aria-label={t("settings.rows.git.ariaLabel")}
                  aria-checked={state.commitChanges}
                  disabled={!api?.setSettings}
                  onClick={() => state.saveGit(!state.commitChanges)}
                />
              </span>
            </div>
          </LoadingBoundary>
        </section>
        <section className="sec settings-startup">
          <h3>{t("uxSettings.startup")}</h3>
          <LoginItemRow api={api} />
          <AppUpdateRow api={api} />
        </section>
        <section className="sec settings-language">
          <h3>{t("rail.language")}</h3>
          <span data-testid="settings-language-control">
            <SegmentedControl
              ariaLabel={t("settings.rows.language.ariaLabel")}
              options={[
                { label: t("uxSettings.french"), value: "fr" },
                { label: t("uxSettings.english"), value: "en" },
              ]}
              value={language}
              onValueChange={setLanguage}
            />
          </span>
        </section>
        <section className="sec">
          <h3>{t("uxSettings.about")}</h3>
          <p className="settings-about">{t("uxSettings.aboutCopy", { version })}</p>
        </section>
        <details className="sec settings-advanced">
          <summary>{t("uxSettings.advanced")}</summary>
          <dl className="kv">
            <dt>{t("uxSettings.socket")}</dt>
            <dd>
              <code>{state.status?.socketPath ?? t("settings.paths.none")}</code>
            </dd>
            <dt>{t("uxSettings.token")}</dt>
            <dd>
              {t("uxSettings.tokenHint")} ·{" "}
              <button
                className="canvas-secondary-button is-small"
                type="button"
                data-testid="settings-agents-rotate"
                disabled={state.rotating || !api?.rotateAgentToken}
                onClick={() => void state.rotate()}
              >
                {t("uxSettings.rotate")}
              </button>
            </dd>
            <dt>{t("uxSettings.journal")}</dt>
            <dd>
              <code>{state.paths.store ?? t("settings.paths.none")}</code>
            </dd>
          </dl>
        </details>
        {import.meta.env.DEV ? (
          <section className="sec" data-testid="settings-development">
            <h3>{t("uxSettings.development")}</h3>
            <AiCard
              api={api}
              intelligence={state.intelligence}
              onIntelligenceChange={state.saveIntelligence}
              onNavigateToRoute={onNavigateToRoute}
            />
            <FeaturesCard features={state.features} onFeatureChange={state.saveFeature} />
          </section>
        ) : null}
        {state.error ? <p role="alert">{t("projectView.operationFailed")}</p> : null}
      </div>
    </section>
  );
}
