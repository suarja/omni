import type { ReactElement } from "react";

import type { ResourceSnapshot } from "../../../domain/resource-catalogue";
import type { SkillLocationKey } from "../../../domain/skill-reconciliation/types";
import type { SkillResult } from "../../../shared/skill-management-ipc";
import { Icon } from "../../components/Icon";
import { resultLabel } from "./operation-view-model";
import { useI18n } from "../../i18n";
import { harnessLabel } from "../../operations/assignment-plan-view";
import { ChangesResult } from "./ChangesResult";

export function CopyManagementResult(
  props: Readonly<{
    result: SkillResult | null;
    localNoWrite: boolean;
    target: SkillLocationKey;
    snapshot: ResourceSnapshot;
  }>,
): ReactElement {
  const { t } = useI18n();
  const projectName =
    props.snapshot.registry.projects.find((project) => project.ref.id === props.target.projectId)?.displayName ??
    props.target.projectId;
  const nameFor = (id: string): string =>
    props.snapshot.registry.projects.find((project) => project.ref.id === id)?.displayName ??
    props.snapshot.registry.sources.find((source) => source.ref.id === id)?.displayName ??
    id;

  if (props.localNoWrite) {
    return (
      <section aria-live="polite" className="copy-management-local-result" data-testid="copy-management-result">
        <h3>{t("skillManagement.copyKept")}</h3>
        <p>{t("skillManagement.keepCopyConsequence")}</p>
        <p>
          {projectName} · {harnessLabel(props.target.harnessId, t)}
        </p>
        <details>
          <summary>{t("canvas.details")}</summary>
          <code>{props.target.folderPath}</code>
        </details>
      </section>
    );
  }
  const result = props.result;
  const statusKeys = {
    applied: "statusApplied",
    "no-op": "statusNoOp",
    partial: "statusPartial",
    failed: "statusFailed",
    cancelled: "statusFailed",
    recovery: "statusRecovery",
    restored: "statusRestored",
    applying: "statusApplying",
  } as const;
  const successful = result?.status === "applied";
  const title =
    successful && result.detachment?.status === "detached"
      ? "skillManagement.detachmentStopped"
      : successful && result.resolution?.choice === "keep-local"
        ? "skillManagement.localContentRetained"
        : result
          ? (`skillManagement.${statusKeys[resultLabel(result)]}` as const)
          : "skillManagement.savedResultUnavailable";
  return result ? (
    <div aria-live="polite" className="copy-management-result" data-testid="copy-management-result">
      <div className="copy-management-result-mark">
        <Icon name={successful || result.status === "restored" ? "review" : "warning"} size={18} />
        <strong>{t(title)}</strong>
      </div>
      <p>
        {projectName} · {harnessLabel(props.target.harnessId, t)}
      </p>
      {result.issues.map((issue) => (
        <p className="changes-error" role="alert" key={`${issue.code}:${issue.message}`}>
          {issue.message}
        </p>
      ))}
      {result.recoveryAvailable && result.status !== "applied" && result.status !== "restored" ? (
        <p className="changes-recovery">{t("skillManagement.recovery")}</p>
      ) : null}
      <details className="copy-management-details">
        <summary>{t("canvas.details")}</summary>
        <ChangesResult
          result={props.result}
          onRestore={() => undefined}
          nameFor={nameFor}
          showRestoreAction={false}
          t={t}
        />
      </details>
    </div>
  ) : (
    <p className="changes-error" role="alert">
      {t("skillManagement.savedResultUnavailable")}
    </p>
  );
}
