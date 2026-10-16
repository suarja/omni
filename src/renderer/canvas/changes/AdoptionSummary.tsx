import type { ReactElement } from "react";

import type { SkillBindingEffect, SkillEffectStep, SkillScope } from "../../../shared/skill-management-ipc";
import type { SkillUseEffect } from "../../../domain/skill-reconciliation/types";
import { resolveTarget } from "../../../domain/harness-targets";
import { useI18n, type TranslationFunction } from "../../i18n";

type AdoptionSummaryProps = Readonly<{
  variant: "diff" | "targets";
  scope: SkillScope;
  steps: readonly SkillEffectStep[];
  nameFor: (id: string) => string;
}>;

function adoptionSteps(steps: readonly SkillEffectStep[]): readonly SkillEffectStep[] {
  return steps.filter((step) => step.plan.kind === "adopt-skill" || step.metadataEffects?.length);
}

function bindingMessage(effect: SkillBindingEffect | undefined, t: TranslationFunction): string {
  if (!effect) return t("skillManagement.adoptionBindingUnchanged");
  if (!effect.after) return t("skillManagement.adoptionBindingRemoved");
  if (!effect.before) return t("skillManagement.adoptionBindingEffect");
  return t(
    JSON.stringify(effect.before) === JSON.stringify(effect.after)
      ? "skillManagement.adoptionBindingUnchanged"
      : "skillManagement.adoptionBindingUpdated",
  );
}

function useMessage(effect: SkillUseEffect, t: TranslationFunction): string {
  if (!effect.after) return t("skillManagement.adoptionUseRemoved");
  if (!effect.before) return t("skillManagement.adoptionUseEffect");
  return t(
    JSON.stringify(effect.before) === JSON.stringify(effect.after)
      ? "skillManagement.adoptionUseUnchanged"
      : "skillManagement.adoptionUseRefresh",
  );
}

function BindingSummary(
  props: Readonly<{
    effect: SkillBindingEffect;
    nameFor: (id: string) => string;
  }>,
): ReactElement {
  const { t } = useI18n();
  const binding = props.effect.after ?? props.effect.before!;
  const folder = binding.artifactPath
    .replace(/\/SKILL\.md$/u, "")
    .split("/")
    .at(-1)!;
  const target = resolveTarget({ kind: "skill", id: folder, harnessId: binding.harnessId });
  return (
    <article className="changes-adoption-effect">
      <h3>
        {props.nameFor(binding.projectId)} · {binding.harnessId}
      </h3>
      {target.status === "target" ? <code>{target.relativePath}</code> : null}
      <p className="changes-note">{bindingMessage(props.effect, t)}</p>
      <details>
        <summary>{t("canvas.details")}</summary>
        <dl>
          <div>
            <dt>{t("skillManagement.assignmentBinding")}</dt>
            <dd>{binding.bindingId}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

function sourceName(scope: SkillScope, nameFor: (id: string) => string): string {
  if (!scope.sourceId) return "";
  return [nameFor(scope.sourceId), scope.packageId, scope.artifactPath].filter(Boolean).join(" / ");
}

export function AdoptionSummary(props: AdoptionSummaryProps): ReactElement {
  const { t } = useI18n();
  const steps = adoptionSteps(props.steps);
  if (!steps.length) return <p className="changes-empty">{t("skillManagement.emptyDiff")}</p>;
  return (
    <section
      aria-label={t("skillManagement.adoptionEffects")}
      className={`changes-adoption-summary is-${props.variant}`}
    >
      {props.scope.sourceId ? (
        <p className="changes-note">
          {t("skillManagement.source")}: {sourceName(props.scope, props.nameFor)}
        </p>
      ) : null}
      <p className="changes-adoption-no-files">{t("skillManagement.adoptionNoFileChanges")}</p>
      {props.variant === "diff" ? (
        <div className="changes-adoption-effects">
          {steps.flatMap((step) =>
            (step.metadataEffects ?? []).map((effect) => {
              const managedUse = effect.after ?? effect.before;
              const binding = step.bindingEffects.find((candidate) => candidate.bindingId === managedUse?.bindingId);
              const base = step.baseReferences?.find(
                (candidate) => candidate.baseRevisionId === managedUse?.baseRevisionId,
              );
              const evidence = step.adoptionEvidence?.locals.find(
                (candidate) =>
                  candidate.location.projectId === effect.location.projectId &&
                  candidate.location.harnessId === effect.location.harnessId &&
                  candidate.location.folderPath === effect.location.folderPath,
              );
              return (
                <article
                  className="changes-adoption-effect"
                  key={`${step.stepId}:${effect.skillId}:${effect.location.folderPath}`}
                >
                  <h3>
                    {props.nameFor(effect.location.projectId)} · {effect.location.harnessId}
                  </h3>
                  <code>{effect.location.folderPath}</code>
                  <p className="changes-note">{bindingMessage(binding, t)}</p>
                  <details>
                    <summary>{t("canvas.details")}</summary>
                    <dl>
                      <div>
                        <dt>{t("skillManagement.sourceSkill")}</dt>
                        <dd>
                          {managedUse ? `${managedUse.source.packageId} / ${managedUse.source.artifactPath}` : ""}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("skillManagement.managedUse")}</dt>
                        <dd>{useMessage(effect, t)}</dd>
                      </div>
                      <div>
                        <dt>{t("skillManagement.assignmentBinding")}</dt>
                        <dd>{binding?.bindingId ?? managedUse?.bindingId ?? ""}</dd>
                      </div>
                      <div>
                        <dt>
                          {t(
                            effect.after
                              ? "skillManagement.commonRestoreBase"
                              : "skillManagement.retainedHistorySnapshot",
                          )}
                        </dt>
                        <dd>
                          {base?.baseRevisionId ?? managedUse?.baseRevisionId ?? t("skillManagement.notRecorded")}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("skillManagement.matchedTreeEvidence")}</dt>
                        <dd>
                          {evidence
                            ? `${evidence.revision.files.length} files · ${evidence.revision.hash}`
                            : t("skillManagement.notRecorded")}
                        </dd>
                      </div>
                    </dl>
                  </details>
                </article>
              );
            }),
          )}
          {steps.flatMap((step) =>
            step.bindingEffects
              .filter(
                (binding) =>
                  !(step.metadataEffects ?? []).some(
                    (effect) => (effect.after ?? effect.before)?.bindingId === binding.bindingId,
                  ),
              )
              .map((effect) => (
                <BindingSummary key={`${step.stepId}:${effect.bindingId}`} effect={effect} nameFor={props.nameFor} />
              )),
          )}
        </div>
      ) : (
        <div className="changes-adoption-targets">
          {steps.flatMap((step) =>
            (step.metadataEffects ?? []).map((effect) => (
              <article
                className="changes-reviewed-target"
                key={`${step.stepId}:${effect.skillId}:${effect.location.folderPath}`}
              >
                <h3>
                  {props.nameFor(effect.location.projectId)} · {effect.location.harnessId}
                </h3>
                <code>{effect.location.folderPath}</code>
              </article>
            )),
          )}
          {steps.flatMap((step) =>
            step.bindingEffects
              .filter(
                (binding) =>
                  !(step.metadataEffects ?? []).some(
                    (effect) => (effect.after ?? effect.before)?.bindingId === binding.bindingId,
                  ),
              )
              .map((effect) => (
                <BindingSummary key={`${step.stepId}:${effect.bindingId}`} effect={effect} nameFor={props.nameFor} />
              )),
          )}
          <p className="changes-note">{t("skillManagement.otherCopiesRemainUnchanged")}</p>
        </div>
      )}
    </section>
  );
}
