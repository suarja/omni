import { storefrontDestination } from "../../../domain/storefront-destination";
import type { ReactElement } from "react";
import { useCanvasRail } from "../rail/rail-context";
import { CanvasGlyph } from "../CanvasGlyph";
import { useI18n } from "../../i18n";
import { changedSkillCount } from "./presentation-model";
export function StorefrontReviewChecks(): ReactElement | null {
  const rail = useCanvasRail(),
    { t } = useI18n();
  if (!rail) return null;
  return (
    <>
      {rail.storefronts.error ? <p role="alert">{t("storefronts.unavailable")}</p> : null}
      {rail.storefronts.drift?.storefronts.flatMap((storefront) => {
        const details = rail.storefronts.details.get(storefront.sourceId);
        const destination = storefrontDestination(details?.status === "ready" ? details.inspection : undefined);
        return storefront.plugins
          .filter((plugin) => plugin.status === "ready" && plugin.behind)
          .map((plugin) => (
            <div className="rail-item" key={`${storefront.sourceId}:${plugin.pluginId}`}>
              <span className="rail-tile is-pending">
                <CanvasGlyph name="warn" />
              </span>
              <div>
                <strong>
                  {t("storefronts.reviewChanged", { plugin: plugin.pluginId, storefront: storefront.name })}
                </strong>
                <small>
                  {t("storefronts.reviewWhere", { storefront: storefront.name })} ·{" "}
                  {destination ? <>{destination} · </> : null}
                  {t("storefronts.reviewSkills", { count: changedSkillCount(plugin) })}
                </small>
              </div>
              <button
                className="canvas-secondary-button is-small"
                type="button"
                onClick={() =>
                  rail.openPublish({ pluginId: plugin.pluginId, storefrontId: storefront.sourceId, update: true })
                }
              >
                {t("storefronts.viewPublish")}
              </button>
            </div>
          ));
      })}
    </>
  );
}
