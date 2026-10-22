import type { ReactElement } from "react";
import { useCanvasRail } from "../rail/rail-context";
import { translateCount, useI18n } from "../../i18n";
export function WorkshopDeliveryLink(): ReactElement | null {
  const rail = useCanvasRail(),
    { t } = useI18n();
  if (!rail?.delivery.status?.workshop) return null;
  const sync = rail.delivery.status.workshop.sync;
  return (
    <button className="canvas-secondary-button" type="button" onClick={() => rail.open("delivery")}>
      {t("delivery.details")} · {t(`delivery.sync.${sync.status}`)}
      {sync.ahead ? ` · ${translateCount(t, "delivery.ahead", sync.ahead)}` : ""}
    </button>
  );
}
