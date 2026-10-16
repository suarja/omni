import type { ReactElement } from "react";

import type { SkillIntent } from "../../shared/skill-management-ipc";
import type { SkillLocationKey } from "../../domain/skill-reconciliation/types";
import { useI18n } from "../i18n";

export function SkillDetachmentControls(
  props: Readonly<{
    canReview: boolean;
    location: SkillLocationKey;
    skillId: string;
    onReview: (intent: Extract<SkillIntent, { kind: "reconcile" }>) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  return (
    <section aria-label={t("skillManagement.detachmentEffects")} className="canvas-skill-adoption">
      <button
        disabled={!props.canReview}
        onClick={() =>
          props.onReview({
            kind: "reconcile",
            request: { choice: "detach-managed", skillId: props.skillId, locations: [props.location] },
          })
        }
        type="button"
      >
        {t("skillManagement.detachmentReview")}
      </button>
    </section>
  );
}
