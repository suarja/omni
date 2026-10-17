import { LoadingSkeleton } from "../../components/ui/Skeleton";
import type { ReactElement } from "react";

import type { SkillVariantDestination } from "../skill-variant-destinations";
import { CanvasSelect, type CanvasSelectOption } from "../CanvasSelect";
import { useI18n } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import type { CopyManagementAction } from "./copy-management-actions";

const actionKey = {
  keep: "skillManagement.keepThisCopy",
  link: "skillManagement.manageWithOmni",
  canonical: "skillManagement.useMarketplaceVersion",
  capture: "skillManagement.copyToMarketplace",
  detach: "skillManagement.stopManagingCopy",
} as const satisfies Record<CopyManagementAction, TranslationKey>;
const consequenceKey = {
  keep: "skillManagement.keepCopyConsequence",
  link: "skillManagement.linkCopyConsequence",
  canonical: "skillManagement.canonicalCopyConsequence",
  capture: "skillManagement.captureCopyConsequence",
  detach: "skillManagement.detachCopyConsequence",
} as const satisfies Record<CopyManagementAction, TranslationKey>;

export function CopyManagementDecision(
  props: Readonly<{
    action: CopyManagementAction | "";
    actions: readonly CopyManagementAction[];
    onActionChange: (action: CopyManagementAction) => void;
    targetReadable: boolean;
    sourceValue: string;
    sourceOptions: readonly CanvasSelectOption[];
    sourceStatus: "idle" | "loading" | "unavailable" | "empty" | "ready";
    onSourceChange: (value: string) => void;
    onRetrySource: () => void;
    destinations: readonly SkillVariantDestination[];
    destinationValue: string;
    onDestinationChange: (value: string) => void;
    skillKey: string;
    onSkillKeyChange: (value: string) => void;
    busy: boolean;
  }>,
): ReactElement {
  const { t } = useI18n();
  const actionOptions = props.actions.map((action) => ({ value: action, label: t(actionKey[action]) }));
  const destinationOptions = props.destinations.map((destination) => ({
    value: `${destination.sourceId}:${destination.packageId}`,
    label: `${destination.sourceName} · ${destination.packageName}`,
  }));
  return (
    <div className="copy-management-decision">
      <CanvasSelect
        disabled={props.busy || props.actions.length < 2}
        label={t("skillManagement.copyAction")}
        onChange={(value) => props.onActionChange(value as CopyManagementAction)}
        options={actionOptions}
        placeholder={t("skillManagement.chooseCopyAction")}
        value={props.action}
      />
      {props.action ? <p className="copy-management-consequence">{t(consequenceKey[props.action])}</p> : null}
      {props.action === "link" ? (
        <div className="copy-management-required-choice">
          <CanvasSelect
            disabled={props.busy || !props.targetReadable}
            label={t("skillManagement.marketplaceSkill")}
            onChange={props.onSourceChange}
            options={props.sourceOptions}
            placeholder={t("skillManagement.chooseMarketplaceSkill")}
            value={props.sourceValue}
          />
          {props.sourceStatus === "loading" ? (
            <LoadingSkeleton label={t("skillManagement.loadingSourceSkills")} variant="rows" />
          ) : null}
          {props.sourceStatus === "unavailable" ? (
            <div className="copy-management-recovery">
              <p>{t("skillManagement.openSourceToLoadSkills")}</p>
              <button className="changes-secondary" disabled={props.busy} onClick={props.onRetrySource} type="button">
                {t("skillManagement.retrySourceSkills")}
              </button>
            </div>
          ) : null}
          {props.sourceStatus === "empty" ? <p>{t("skillManagement.noSkillsInPackage")}</p> : null}
        </div>
      ) : null}
      {props.action === "capture" ? (
        <div className="copy-management-required-choice">
          <CanvasSelect
            disabled={props.busy || !props.targetReadable}
            label={t("skillManagement.personalDestination")}
            onChange={props.onDestinationChange}
            options={destinationOptions}
            placeholder={t("skillManagement.chooseDestination")}
            value={props.destinationValue}
          />
          {!destinationOptions.length ? (
            <p className="changes-error">{t("skillManagement.noPersonalDestination")}</p>
          ) : null}
          <label className="canvas-select-field">
            <span>{t("skillManagement.variantKey")}</span>
            <input
              autoComplete="off"
              disabled={props.busy || !props.targetReadable}
              maxLength={64}
              onChange={(event) => props.onSkillKeyChange(event.target.value)}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              value={props.skillKey}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
