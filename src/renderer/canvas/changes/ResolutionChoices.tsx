import { useId, type ReactElement } from "react";

import type { SkillManagedResolutionChoice } from "../../../shared/skill-reconciliation-request";
import { useI18n } from "../../i18n";

type ResolutionChoice = SkillManagedResolutionChoice | "keep-variant";

export function ResolutionChoices(
  props: Readonly<{
    value?: ResolutionChoice;
    disabled: boolean;
    includeVariant?: boolean;
    onChange: (choice: ResolutionChoice) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const id = useId();
  return (
    <fieldset
      aria-label={t("skillManagement.resolutionChoice")}
      className="changes-resolution-choices"
      disabled={props.disabled}
    >
      <legend>{t("skillManagement.resolutionChoice")}</legend>
      {(["keep-local", "use-canonical", ...(props.includeVariant ? ["keep-variant" as const] : [])] as const).map(
        (choice) => (
          <label key={choice}>
            <input
              checked={props.value === choice}
              name={id}
              onChange={() => props.onChange(choice)}
              type="radio"
              value={choice}
            />
            <span>
              <strong>
                {t(
                  choice === "keep-local"
                    ? "skillManagement.keepLocal"
                    : choice === "use-canonical"
                      ? "skillManagement.useCanonical"
                      : "skillManagement.keepVariant",
                )}
              </strong>
              <small>
                {t(
                  choice === "keep-local"
                    ? "skillManagement.keepLocalDescription"
                    : choice === "use-canonical"
                      ? "skillManagement.useCanonicalDescription"
                      : "skillManagement.keepVariantDescription",
                )}
              </small>
            </span>
          </label>
        ),
      )}
    </fieldset>
  );
}
