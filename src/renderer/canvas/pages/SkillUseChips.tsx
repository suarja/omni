import type { ReactElement } from "react";
import type { ExternalUse } from "../../../shared/external-library-ipc";
import { useI18n } from "../../i18n";
import { skillUseChips } from "./skill-use-chip-model";

export function SkillUseChips(
  props: Readonly<{ uses: readonly ExternalUse[]; peers?: readonly ExternalUse[] }>,
): ReactElement {
  const { t } = useI18n();
  return (
    <span className="external-chips">
      {skillUseChips(props.uses, props.peers ?? props.uses, t).map((chip) => (
        <span key={chip.id} className={`project-chip ${chip.className}`}>
          {chip.label}
        </span>
      ))}
    </span>
  );
}
