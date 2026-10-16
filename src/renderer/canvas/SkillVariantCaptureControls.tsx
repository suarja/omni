import { useState, type ReactElement } from "react";

import type { SkillLocationKey } from "../../domain/skill-reconciliation/types";
import type { SkillIntent } from "../../shared/skill-management-ipc";
import type { SkillVariantDestination } from "./skill-variant-destinations";
import { useI18n } from "../i18n";

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[\u0300-\u036f]/gu, "")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 64)
      .replace(/-$/u, "") || "personal-copy"
  );
}

export function SkillVariantCaptureControls(
  props: Readonly<{
    skillId: string;
    label: string;
    projectName: string;
    location: SkillLocationKey;
    destinations: readonly SkillVariantDestination[];
    canReview: boolean;
    onSelectionChanged?: () => void;
    onReview: (intent: Extract<SkillIntent, { kind: "reconcile" }>) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const choices = props.destinations;
  const [destinationKey, setDestinationKey] = useState("");
  const [skillKey, setSkillKey] = useState(() => slug(`${props.label}-${props.projectName}`));
  const selected = choices.find(({ sourceId, packageId }) => `${sourceId}:${packageId}` === destinationKey);
  return (
    <section aria-label={t("skillManagement.captureVariant")} className="canvas-skill-variant">
      <p className="canvas-meta-label">{t("skillManagement.captureVariant")}</p>
      <label>
        <span>{t("skillManagement.personalSource")}</span>
        <select
          aria-label={t("skillManagement.personalSource")}
          value={destinationKey}
          onChange={(event) => {
            setDestinationKey(event.target.value);
            props.onSelectionChanged?.();
          }}
        >
          <option value="">{t("skillManagement.chooseDestination")}</option>
          {choices.map((choice) => (
            <option key={`${choice.sourceId}:${choice.packageId}`} value={`${choice.sourceId}:${choice.packageId}`}>
              {choice.sourceName} · {choice.packageName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("skillManagement.variantKey")}</span>
        <input
          aria-label={t("skillManagement.variantKey")}
          autoComplete="off"
          maxLength={64}
          onChange={(event) => {
            setSkillKey(event.target.value);
            props.onSelectionChanged?.();
          }}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          value={skillKey}
        />
      </label>
      {!choices.length ? <p className="canvas-error">{t("skillManagement.noPersonalDestination")}</p> : null}
      <button
        className="canvas-secondary-button"
        disabled={!props.canReview || !selected || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillKey)}
        onClick={() =>
          selected &&
          props.onReview({
            kind: "reconcile",
            request: {
              choice: "keep-variant",
              skillId: props.skillId,
              locations: [props.location],
              destination: { sourceId: selected.sourceId, packageId: selected.packageId, skillKey },
            },
          })
        }
        type="button"
      >
        {t("skillManagement.reviewVariantCapture")}
      </button>
    </section>
  );
}
