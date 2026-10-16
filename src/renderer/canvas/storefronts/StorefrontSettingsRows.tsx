import { storefrontDestination } from "../../../domain/storefront-destination";
import type { ReactElement } from "react";
import { useI18n } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
export function StorefrontSettingsRows(): ReactElement | null {
  const rail = useCanvasRail(),
    { t } = useI18n();
  if (!rail) return null;
  return (
    <>
      {rail.canvas.snapshot.registry.sources
        .filter((source) => source.role === "storefront" && !source.archivedAt)
        .map((source) => {
          const details = rail.storefronts.details.get(source.ref.id);
          const destination = storefrontDestination(details?.status === "ready" ? details.inspection : undefined);
          return (
            <div className="item" key={source.ref.id}>
              <div className="grow">
                <b>{t("storefronts.node", { name: source.displayName })}</b>
                <small>
                  {source.displayRoot}
                  {destination ? ` · ${destination}` : ""}
                </small>
              </div>
              <button
                className="canvas-secondary-button is-small"
                type="button"
                onClick={() => rail.openStorefront(source.ref.id)}
              >
                {t("rail.open")}
              </button>
            </div>
          );
        })}
    </>
  );
}
