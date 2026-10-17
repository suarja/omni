import { LoadingBoundary, LoadingSkeleton } from "../../components/ui/Skeleton";
import { storefrontDestination } from "../../../domain/storefront-destination";
import { useState, type ReactElement } from "react";
import { activeWorkshop } from "../../../domain/source-roles";
import { useI18n } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { SheetFrame } from "../SheetFrame";
import { Glossary } from "../Glossary";
import { personalMarketplace } from "../personal-marketplace";
import {
  changedSkillCount,
  latestStorefrontReceipts,
  publicationDate,
  publicationTimestamp,
  pluginIdFor,
} from "./presentation-model";
import "./storefronts.css";

export function StorefrontSheet(): ReactElement | null {
  const rail = useCanvasRail();
  const { t, language } = useI18n();
  const [error, setError] = useState<string | null>(null);
  if (!rail?.storefrontId) return null;
  const { canvas, storefrontId, storefronts } = rail;
  const source = canvas.snapshot.registry.sources.find((source) => source.ref.id === storefrontId);
  const details = storefronts.details.get(storefrontId);
  const initialLoading = storefronts.loading && !details;
  const ready = details?.status === "ready" ? details : undefined;
  const report = storefronts.drift?.storefronts.find((item) => item.sourceId === storefrontId);
  const behind = report?.plugins.filter((plugin) => plugin.status === "ready" && plugin.behind) ?? [];
  const workshop = activeWorkshop(canvas.snapshot.registry)?.displayName ?? t("projectView.marketplace");
  const plugins = personalMarketplace(canvas.snapshot)?.plugins ?? [];
  const receipts = latestStorefrontReceipts(storefronts.receipts, storefrontId);
  const pending = receipts.filter(
    (receipt) =>
      receipt.publication?.state === "committed-not-pushed" || receipt.publication?.state === "push-outcome-unknown",
  );
  const lastPublication = (ready ? [...ready.publications] : []).sort((a, b) =>
    b.publishedTime.localeCompare(a.publishedTime),
  )[0];
  const lastReceipt = [...receipts].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))[0];
  async function openRepository(): Promise<void> {
    try {
      if (!canvas.api?.openStorefrontRepository) throw new Error(t("storefronts.unavailable"));
      const result = await canvas.api.openStorefrontRepository({ sourceId: storefrontId! });
      if (result.status !== "opened") throw new Error(result.message);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("storefronts.unavailable"));
    }
  }
  function publish(pluginId?: string): void {
    rail?.openPublish({ pluginId, storefrontId, update: Boolean(pluginId) });
  }
  return (
    <SheetFrame
      title={source?.displayName ?? storefrontId}
      kicker={
        <>
          {t("storefronts.title")} <Glossary concept="storefront" />
        </>
      }
      subtitle={ready?.description}
      testId="storefront-sheet"
      className="storefront-sheet"
      onClose={rail.close}
      footer={
        <>
          <button
            className="canvas-secondary-button"
            type="button"
            disabled={!ready?.inspection.githubRepository}
            onClick={() => void openRepository()}
          >
            {t("storefronts.openGithub")}
          </button>
          <span className="skill-footer-note" />
          <button className="canvas-secondary-button is-primary" type="button" onClick={() => publish()}>
            {t("storefronts.publishPlugin")}
          </button>
        </>
      }
    >
      {behind.length ? (
        <div className="storefront-callout is-info">
          <div className="grow">
            <b>
              {t(behind.length === 1 ? "storefronts.changed" : "storefronts.changedMany", {
                name: behind[0].pluginId,
                count: behind.length,
              })}
            </b>
            <br />
            {t("storefronts.behindHint")}
          </div>
          <button
            className="canvas-secondary-button is-small is-primary"
            type="button"
            onClick={() => publish(behind[0].pluginId)}
          >
            {t("storefronts.viewPublish")}
          </button>
        </div>
      ) : null}
      {pending.map((receipt) => (
        <div className="storefront-callout is-warn" key={receipt.operationId}>
          <div className="grow">
            <b>
              {t(
                receipt.publication?.state === "push-outcome-unknown"
                  ? "storefronts.pushUnknown"
                  : "storefronts.notPushed",
              )}
            </b>
            <small>{receipt.publication?.pluginId ?? source?.displayName}</small>
          </div>
          <button
            className="canvas-secondary-button is-small"
            type="button"
            onClick={() => rail.openPublish({ storefrontId, retryOperationId: receipt.operationId })}
          >
            {t("storefronts.retry")}
          </button>
        </div>
      ))}
      <section className="sec">
        <h3>
          {t("storefronts.publishedPlugins", {
            count: Math.max(report?.plugins.length ?? 0, ready?.inspection.plugins.length ?? 0),
          })}{" "}
          <Glossary concept="publish" />
        </h3>
        <LoadingBoundary
          loading={initialLoading}
          label={t("canvas.loadingSurface", { surface: source?.displayName ?? t("projectView.marketplace") })}
          minHeight={216}
        >
          <div className="storefront-rows">
            {(report?.plugins ?? []).map((drift) => {
              const publication = ready?.publications.find((record) => record.pluginId === drift.pluginId);
              const origin = ready?.inspection.plugins.find((plugin) => plugin.pluginId === drift.pluginId)?.origin;
              const workshopPlugin = plugins.find((plugin) => pluginIdFor(plugin.id) === drift.pluginId);
              return (
                <div className="storefront-row" key={drift.pluginId}>
                  <div className="rn">
                    <b>{drift.pluginId}</b>
                    <small title={origin?.sourcePath}>
                      {publication || origin
                        ? t("storefronts.origin", {
                            count: workshopPlugin?.count ?? 0,
                            workshop,
                            plugin: drift.pluginId,
                            date: publicationDate(publication?.publishedTime ?? origin?.publishedTime, language),
                          })
                        : t("canvas.notRead")}
                    </small>
                    <div className="storefront-chips">
                      <span
                        className={`project-chip ${drift.status !== "ready" ? "is-local" : drift.behind ? "is-update" : "is-installed"}`}
                      >
                        {drift.status !== "ready"
                          ? drift.message
                          : drift.behind
                            ? t("storefronts.changedSkills", { count: changedSkillCount(drift) })
                            : t("storefronts.upToDate")}
                      </span>
                    </div>
                  </div>
                  {drift.status === "ready" && drift.behind ? (
                    <button
                      className="canvas-secondary-button is-small"
                      type="button"
                      onClick={() => publish(drift.pluginId)}
                    >
                      {t("storefronts.update")}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {ready?.inspection.plugins
            .filter((plugin) => !report?.plugins.some((drift) => drift.pluginId === plugin.pluginId))
            .map((plugin) => (
              <div className="storefront-row" key={plugin.pluginId}>
                <div className="rn">
                  <b>{plugin.name}</b>
                  <small>{t("storefronts.unrecognized", { plugin: plugin.name })}</small>
                </div>
              </div>
            ))}
          {report && !report.plugins.length && !ready?.inspection.plugins.length ? (
            <p>{t("storefronts.empty")}</p>
          ) : null}
          <button
            className="canvas-secondary-button is-small is-ghost storefront-add"
            type="button"
            onClick={() => publish()}
          >
            {t("storefronts.publishAnother")}
          </button>
        </LoadingBoundary>
      </section>
      <section className="sec">
        <h3>{t("storefronts.repository")}</h3>
        <dl className="storefront-kv">
          <dt>{t(ready?.inspection.githubRepository ? "storefronts.github" : "storefronts.repository")}</dt>
          <dd>
            {initialLoading ? (
              <LoadingSkeleton label={t("storefronts.repository")} variant="inline" />
            ) : (
              storefrontDestination(ready?.inspection) || t("canvas.notRead")
            )}
            {ready?.inspection.githubRepository ? ` · ${t("storefronts.repositoryPublic")}` : ""}
          </dd>
          <dt>{t("storefronts.folder")}</dt>
          <dd>{source?.displayRoot}</dd>
          <dt>{t("storefronts.license")}</dt>
          <dd>
            {initialLoading ? (
              <LoadingSkeleton label={t("storefronts.license")} variant="inline" />
            ) : (
              (ready?.license ?? t("canvas.notRead"))
            )}
          </dd>
          <dt>{t("storefronts.last")}</dt>
          <dd>
            {initialLoading ? (
              <LoadingSkeleton label={t("storefronts.last")} variant="inline" />
            ) : lastPublication ? (
              `${publicationTimestamp(lastPublication.publishedTime, language)} · ${t(lastReceipt?.publication?.state === "pushed" ? "storefronts.pushed" : lastReceipt?.publication?.state === "committed-not-pushed" ? "storefronts.notPushed" : "storefronts.unknownPush")}`
            ) : (
              t("storefronts.noPublication")
            )}
          </dd>
        </dl>
      </section>
      <p className="sh-sub">{t("storefronts.writeHint")}</p>
      {storefronts.error || details?.status === "blocked" || error ? (
        <p role="alert">{error ?? (details?.status === "blocked" ? details.message : t("storefronts.unavailable"))}</p>
      ) : null}
    </SheetFrame>
  );
}
