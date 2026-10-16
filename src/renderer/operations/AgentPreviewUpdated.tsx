import type { ReactElement } from "react";
import { Callout } from "../components/ui/Callout";
import { useI18n } from "../i18n";

export function AgentPreviewUpdated({ visible }: Readonly<{ visible: boolean }>): ReactElement | null {
  const { t } = useI18n();
  return visible ? (
    <Callout title={t("agents.updatedPreviewTitle")} tone="warning">
      {t("agents.updatedPreview")}
    </Callout>
  ) : null;
}
