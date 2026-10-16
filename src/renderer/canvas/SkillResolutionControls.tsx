import type { ReactElement } from "react";

import type { SkillLocationKey } from "../../domain/skill-reconciliation/types";
import { useI18n } from "../i18n";

export function SkillResolutionControls(
  props: Readonly<{
    canReview: boolean;
    location: SkillLocationKey;
    onReview: (location: SkillLocationKey) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  return (
    <section aria-label={t("skillManagement.resolutionReview")} className="canvas-skill-adoption">
      <p className="canvas-meta-label">{t("skillManagement.managedCopy")}</p>
      <button disabled={!props.canReview} onClick={() => props.onReview(props.location)} type="button">
        {t("skillManagement.reviewResolution")}
      </button>
    </section>
  );
}
