import type { ObservedArtifact } from "../../domain/inventory";
import { countByKind } from "../library/library-data";
import type { ReactElement } from "react";

import type { AssignmentAction, ProjectPlan } from "../../domain/assignment-plan";
import { resolveTarget, type HarnessId } from "../../domain/harness-targets";
import type { CatalogueUnit } from "../catalogue/catalogue";
import type { AuditReport } from "../audit/audit-report";
import type { Observation } from "../../domain/project-source-registry";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Card, CardHeader } from "../components/ui/Card";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { useI18n } from "../i18n";

export const HARNESSES: readonly HarnessId[] = ["claude-code", "codex", "cursor"];
export type ObservationCache = Readonly<Record<string, Observation | undefined>>;

type Translate = ReturnType<typeof useI18n>["t"];

export function observedForProject(
  projectId: string,
  observations: ObservationCache,
  report: AuditReport | null | undefined,
): Observation | undefined {
  return (
    observations[`project:${projectId}`] ??
    report?.observations.find(
      (observation) => observation.subject.kind === "project" && observation.subject.id === projectId,
    )
  );
}

export function harnessLabel(harnessId: HarnessId, t: Translate): string {
  return t(`assignment.${harnessId === "claude-code" ? "claudeCode" : harnessId}` as Parameters<typeof t>[0]);
}

export function planTone(status: ProjectPlan["status"]): BadgeTone {
  return status === "conflict" ? "bad" : "neutral";
}

export function actionTone(state: AssignmentAction["state"]): BadgeTone {
  if (state === "conflict") return "bad";
  if (state === "update") return "warn";
  return "neutral";
}

export function actionLabel(state: AssignmentAction["state"], t: Translate): string {
  return t(`assignment.${state}` as Parameters<typeof t>[0]);
}

export function resolveHarnessTarget(
  kind: CatalogueUnit["kind"],
  id: string,
  harnessId: HarnessId,
): ReturnType<typeof resolveTarget> {
  const targetKind = kind === "rule" ? "instruction" : kind;
  if (!["skill", "instruction", "command", "agent", "hook", "mcp-config"].includes(targetKind))
    return { status: "blocked", reason: "This asset kind has no deterministic target." };
  return resolveTarget({ kind: targetKind as Parameters<typeof resolveTarget>[0]["kind"], id, harnessId });
}

export function HarnessCheckboxRow({
  blockedReason,
  checked,
  checkboxTestId,
  dataTestId,
  disabled,
  harnessId,
  onChange,
  t,
}: Readonly<{
  blockedReason?: string;
  checked: boolean;
  checkboxTestId: string;
  dataTestId: string;
  disabled?: boolean;
  harnessId: HarnessId;
  onChange: () => void;
  t: Translate;
}>): ReactElement {
  return (
    <label className={`assignment-harness${disabled ? " is-disabled" : ""}`} data-testid={dataTestId}>
      <input checked={checked} data-testid={checkboxTestId} disabled={disabled} onChange={onChange} type="checkbox" />
      <span>
        <strong>{harnessLabel(harnessId, t)}</strong>
        {disabled && blockedReason ? <small>{blockedReason}</small> : null}
      </span>
    </label>
  );
}

export function AssignmentPlanCard({
  plan,
  projectName,
  t,
}: Readonly<{ plan: ProjectPlan; projectName: string; t: Translate }>): ReactElement {
  return (
    <Card data-testid={`assignment-preview-${plan.projectId}`}>
      <CardHeader
        hint={
          plan.status === "ready" ? undefined : (
            <Badge tone={planTone(plan.status)} variant="status">
              {t(`assignment.${plan.status}` as Parameters<typeof t>[0])}
            </Badge>
          )
        }
        title={t("assignment.preview", { project: projectName })}
      />
      <ItemList>
        {plan.actions.map((action) => (
          <ListItem
            key={action.bindingId}
            leading={<Badge variant="type">{harnessLabel(action.harnessId, t)}</Badge>}
            name={<code>{action.relativePath}</code>}
            side={
              <Badge tone={actionTone(action.state)} variant="status">
                {actionLabel(action.state, t)}
              </Badge>
            }
            sub={action.reason}
          />
        ))}
      </ItemList>
    </Card>
  );
}

export function WhatWillBeAdded({
  artifacts,
  language,
  t,
}: Readonly<{
  artifacts: readonly ObservedArtifact[];
  language: "en" | "fr";
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  return (
    <Card data-testid="assignment-whole-plugin-card">
      <CardHeader title={t("assignment.whatWillBeAdded")} />
      <ItemList variant="nested">
        <ListItem name={countByKind(artifacts, t, language) || t("assignment.noArtifacts")} />
      </ItemList>
    </Card>
  );
}
