import type { ReactElement } from "react";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import { useI18n } from "../../i18n";

export function DeliveryReceipt({ receipt }: Readonly<{ receipt: OperationReceipt }>): ReactElement | null {
  const { t } = useI18n();
  if (!receipt.workshopPush && !receipt.pluginUpdates) return null;
  return (
    <section className="delivery-receipt" data-testid="workshop-delivery-receipt" role="status">
      {receipt.workshopPush ? (
        <>
          <h3>
            {t(
              receipt.workshopPush.status === "pushed"
                ? "delivery.pushed"
                : receipt.workshopPush.status === "failed"
                  ? "delivery.pushFailed"
                  : "delivery.pushUnknown",
            )}
          </h3>
          <p>{receipt.workshopPush.diagnostic ?? receipt.workshopPush.upstream}</p>
        </>
      ) : null}
      {receipt.pluginUpdates?.map((result, index) => (
        <p key={index}>
          <code>{[result.command.executable, ...result.command.args].join(" ")}</code> · {result.status}
          {result.diagnostic ? ` · ${result.diagnostic}` : ""}
        </p>
      ))}
      {receipt.diagnostic ? <p role="alert">{receipt.diagnostic}</p> : null}
    </section>
  );
}
