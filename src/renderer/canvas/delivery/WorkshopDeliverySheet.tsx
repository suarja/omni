import type { ReactElement } from "react";
import { useCanvasRail } from "../rail/rail-context";
import { useI18n } from "../../i18n";
import { SheetFrame } from "../SheetFrame";
import { WorkshopDeliveryPanel } from "./WorkshopDeliveryPanel";

export function WorkshopDeliverySheet({
  onApplyingChange,
}: Readonly<{ onApplyingChange: (busy: boolean) => void }>): ReactElement | null {
  const rail = useCanvasRail();
  const { t } = useI18n();
  if (!rail) return null;
  const delivery = rail.delivery;
  return (
    <SheetFrame
      title={t("delivery.title")}
      subtitle={t("delivery.subtitle")}
      kicker={null}
      testId="workshop-delivery-sheet"
      resizeKind="details"
      onClose={rail.close}
      busy={rail.blocked.current}
    >
      {delivery.loading && !delivery.status ? <p>{t("delivery.loading")}</p> : null}
      {delivery.error ? <p role="alert">{t("delivery.unavailable")}</p> : null}
      <button className="canvas-secondary-button" type="button" onClick={() => rail.open("settings")}>
        {t("canvas.settings")}
      </button>
      {delivery.status ? (
        <WorkshopDeliveryPanel
          status={delivery.status}
          api={rail.canvas.railServices?.api ?? rail.canvas.api}
          onRefresh={() => {
            delivery.refresh();
            rail.canvas.onRefresh();
          }}
          onApplyingChange={onApplyingChange}
        />
      ) : null}
    </SheetFrame>
  );
}
