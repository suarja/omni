import { activeWorkshop } from "../../domain/source-roles";
import { useMemo, type ReactElement } from "react";

import type { ResourceSnapshot } from "../../domain/resource-catalogue";
import type { ManagedSkillUse, SkillLocationKey } from "../../domain/skill-reconciliation/types";
import type { Observation } from "../../domain/project-source-registry";
import type { SkillIntent } from "../../shared/skill-management-ipc";
import { useI18n } from "../i18n";
import type { LogicalSkillNode } from "./spatial/spatial-types";
import { useOwnedSkillChoices } from "./use-owned-skill-choices";

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

export function SkillAdoptionControls(
  props: Readonly<{
    node: LogicalSkillNode;
    location?: SkillLocationKey;
    snapshot: ResourceSnapshot;
    managedUses: readonly ManagedSkillUse[];
    canReview: boolean;
    onObserveSource?: (sourceId: string, isCurrent: () => boolean) => Promise<Observation | null>;
    onReview: (intent: Extract<SkillIntent, { kind: "reconcile" }>) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const choices = useOwnedSkillChoices(
    props.snapshot,
    props.onObserveSource,
    JSON.stringify([props.node.skillId, props.location ?? null]),
  );
  const sources = useMemo(
    () =>
      [activeWorkshop(props.snapshot.registry)].filter(
        (source): source is NonNullable<typeof source> => source !== undefined && source.availability === "available",
      ),
    [props.snapshot.registry.sources],
  );
  const selectedPackage = choices.packages.find((item) => item.id === choices.packageId);
  const selectedSkill = choices.skills.find((item) => item.id === choices.skillArtifactId);
  const selectedMember = props.node.members.find(
    (member) => props.location && locationKey(member.location) === locationKey(props.location),
  );
  const locationUse = props.managedUses.find(
    (use) => props.location && locationKey(use.location) === locationKey(props.location),
  );
  const existingUse = locationUse?.skillId === props.node.skillId ? locationUse : undefined;
  const conflictingUse = locationUse && !existingUse ? locationUse : undefined;
  const bindingMatches =
    existingUse !== undefined &&
    props.snapshot.uses.status === "ready" &&
    props.snapshot.uses.bindings.some(
      (binding) =>
        binding.bindingId === existingUse.bindingId &&
        binding.projectId === existingUse.location.projectId &&
        binding.harnessId === existingUse.location.harnessId &&
        binding.kind === "skill" &&
        binding.sourceId === existingUse.source.sourceId &&
        binding.packageId === existingUse.source.packageId &&
        (binding.artifactPath === existingUse.source.artifactPath ||
          binding.artifactPath === `${existingUse.source.artifactPath}/SKILL.md`),
    );
  const alreadyManaged = Boolean(
    bindingMatches &&
    existingUse &&
    selectedSkill &&
    selectedPackage &&
    existingUse.source.sourceId === choices.sourceId &&
    existingUse.source.packageId === selectedPackage.id &&
    existingUse.source.artifactPath === selectedSkill.artifactPath,
  );
  const canReview = Boolean(
    props.canReview &&
    props.location &&
    selectedMember?.read.status === "complete" &&
    choices.selected &&
    selectedPackage &&
    selectedSkill &&
    !alreadyManaged &&
    !locationUse,
  );
  const review = (): void => {
    if (!canReview || !props.location || !choices.selected) return;
    props.onReview({
      kind: "reconcile",
      request: {
        choice: "link-canonical",
        skillId: props.node.skillId,
        source: choices.selected.source,
        locations: [props.location],
      },
    });
  };

  return (
    <section aria-label={t("skillManagement.manageWithOmni")} className="canvas-skill-adoption">
      <h3>{t("skillManagement.manageWithOmni")}</h3>
      {conflictingUse ? (
        <p className="canvas-error" role="alert">
          {t("skillManagement.locationManagedByDifferentSkill")}
        </p>
      ) : existingUse && bindingMatches ? (
        <p>{t("skillManagement.alreadyManaged")}</p>
      ) : existingUse ? (
        <p className="canvas-error" role="alert">
          {t("skillManagement.managementEvidenceUnavailable")}
        </p>
      ) : (
        <>
          <label>
            <span>{t("skillManagement.ownedSource")}</span>
            <select
              aria-label={t("skillManagement.ownedSource")}
              onChange={(event) => choices.selectSource(event.target.value)}
              value={choices.sourceId}
            >
              <option value="">{t("skillManagement.chooseOwnedSource")}</option>
              {sources.map((source) => (
                <option key={source.ref.id} value={source.ref.id}>
                  {source.displayName}
                </option>
              ))}
            </select>
          </label>
          {sources.length === 0 ? <p>{t("skillManagement.noOwnedSources")}</p> : null}
          {choices.sourceId ? (
            <>
              {choices.status === "loading" ? (
                <p aria-live="polite">{t("skillManagement.loadingSourceSkills")}</p>
              ) : null}
              {choices.status === "unavailable" ? (
                <div className="canvas-skill-adoption-message">
                  <p>{t("skillManagement.openSourceToLoadSkills")}</p>
                  <button className="canvas-secondary-button" onClick={choices.retrySource} type="button">
                    {t("skillManagement.retrySourceSkills")}
                  </button>
                </div>
              ) : null}
              {!["loading", "unavailable"].includes(choices.status) && choices.packages.length === 0 ? (
                <p>{t("skillManagement.openSourceToLoadSkills")}</p>
              ) : null}
              {choices.packages.length ? (
                <label>
                  <span>{t("skillManagement.sourcePackage")}</span>
                  <select
                    aria-label={t("skillManagement.sourcePackage")}
                    onChange={(event) => choices.selectPackage(event.target.value)}
                    value={choices.packageId}
                  >
                    <option value="">{t("skillManagement.chooseSourcePackage")}</option>
                    {choices.packages.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.relativeRoot}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {selectedPackage ? (
                choices.skills.length ? (
                  <label>
                    <span>{t("skillManagement.sourceSkill")}</span>
                    <select
                      aria-label={t("skillManagement.sourceSkill")}
                      onChange={(event) => choices.selectSkill(event.target.value)}
                      value={choices.skillArtifactId}
                    >
                      <option value="">{t("skillManagement.chooseSourceSkill")}</option>
                      {choices.skills.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} · {item.artifactPath}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p>{t("skillManagement.noSkillsInPackage")}</p>
                )
              ) : null}
              {selectedMember?.read.status !== "complete" ? <p>{t("skillManagement.copyReadRequired")}</p> : null}
              <button className="canvas-secondary-button" disabled={!canReview} onClick={review} type="button">
                {t("skillManagement.reviewCanonicalLink")}
              </button>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
