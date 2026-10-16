import { WorkflowWorkbench } from "./WorkflowWorkbench";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import type { HarnessId } from "../../../domain/harness-targets";
import type { Observation } from "../../../domain/project-source-registry";
import type { DesktopApi } from "../../../shared/ipc";
import type { OperationPlan, OperationReceipt, PreviewMarketplaceResponse } from "../../../shared/operations-ipc";
import type { AuditReport } from "../../audit/audit-report";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Callout";
import { Card, CardHeader } from "../../components/ui/Card";
import { WorkflowFooter } from "./WorkflowFooter";
import { ItemList, ListItem } from "../../components/ui/ItemList";
import { SectionHeading } from "../../components/ui/SectionHeading";
import { tCount, useI18n } from "../../i18n";
import type { Route } from "../../navigation";
import { MarketplacePackagePicker } from "../../operations/ImportArtifactChoices";
import {
  AssignmentPlanCard,
  HARNESSES,
  HarnessCheckboxRow,
  observedForProject,
  resolveHarnessTarget,
  type ObservationCache,
} from "../../operations/assignment-plan-view";
import { formatByteSize, writeFileActions, type Target } from "../../operations/operations-import-plan";

export type CatalogueAssignmentWorkbenchProps = Readonly<{
  api: DesktopApi | null;
  auditReport?: AuditReport | null;
  entry: { ownerRepo: string; skill: string };
  projectId: string;
  projectName: string;
  marketplaceObservation: Observation | null;
  observations?: ObservationCache;
  onEnsureGrant: (ref: { kind: "project"; id: string }) => Promise<string | null>;
  onMarketplaceChanged?: () => void;
  onNavigateToRoute: (route: Route) => void;
  returnTo: Route;
}>;

function importStep(plan: OperationPlan): OperationPlan | undefined {
  return plan.steps?.find((step) => step.kind === "import")?.plan;
}

function assignmentStep(plan: OperationPlan) {
  return plan.steps?.find((step) => step.kind === "assign")?.plan;
}

function ImportPlanSummary({
  entrySkill,
  language,
  packageName,
  plan,
}: Readonly<{
  entrySkill: string;
  language: "en" | "fr";
  packageName: string;
  plan: OperationPlan;
}>): ReactElement | null {
  const step = importStep(plan);
  if (!step) return null;
  const files = writeFileActions(step);
  const totalSize = files.reduce((total, action) => total + (action.byteLength ?? 0), 0);
  return (
    <ListItem
      name={
        <>
          <strong>{entrySkill}</strong> → {packageName}
        </>
      }
      sub={`${tCount("operations.files", files.length, {}, language)} · ${formatByteSize(totalSize)}`}
    />
  );
}

function PlanCard({
  entrySkill,
  language,
  packageName,
  plan,
  projectName,
  t,
}: Readonly<{
  entrySkill: string;
  language: "en" | "fr";
  packageName: string;
  plan: OperationPlan;
  projectName: string;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  const assignment = assignmentStep(plan);
  return (
    <Card data-testid="add-to-project-plan">
      <CardHeader title={t("operations.addToProject.whatWillChange")} />
      <ItemList variant="nested">
        <ImportPlanSummary entrySkill={entrySkill} language={language} packageName={packageName} plan={plan} />
      </ItemList>
      {assignment ? <AssignmentPlanCard plan={assignment} projectName={projectName} t={t} /> : null}
    </Card>
  );
}

function commitLabel(receipt: OperationReceipt | undefined, t: ReturnType<typeof useI18n>["t"]): string {
  return receipt?.git.commit
    ? t("operations.addToProject.commit", { hash: receipt.git.commit.slice(0, 7) })
    : t("operations.noCommit");
}

function ResultCard({
  childReceipts,
  onOpenProject,
  onViewReceipt,
  projectName,
  receipt,
  t,
}: Readonly<{
  childReceipts: readonly OperationReceipt[];
  onOpenProject: () => void;
  onViewReceipt: () => void;
  projectName: string;
  receipt: OperationReceipt;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  const importReceipt = childReceipts.find((child) => child.kind === "import-artifact");
  const projectReceipt = childReceipts.find((child) => child.kind === "apply-plan");
  return (
    <>
      <Card data-testid="add-to-project-result">
        <CardHeader
          title={t("operations.addToProject.result", { project: projectName })}
          count={
            <Badge tone={receipt.status === "applied" ? "ok" : "bad"} variant="status">
              {receipt.status === "applied" ? t("operations.applied") : t("operations.failed")}
            </Badge>
          }
        />
        <ItemList variant="nested">
          <ListItem name={`${t("operations.addToProject.marketplace")} · ${commitLabel(importReceipt, t)}`} />
          <ListItem name={`${t("operations.addToProject.project")} · ${commitLabel(projectReceipt, t)}`} />
        </ItemList>
        {receipt.failedStep ? (
          <Callout title={t("operations.failed")} tone="error">
            {receipt.diagnostic ?? t("operations.failed")}
            <br />
            {t("operations.addToProject.restoreNotice")}
          </Callout>
        ) : null}
      </Card>
      <WorkflowFooter
        actions={
          <>
            <Button dataTestId="add-to-project-open-project" onClick={onOpenProject}>
              {t("operations.addToProject.openProject")}
            </Button>
            <Button dataTestId="add-to-project-view-receipt" onClick={onViewReceipt} tone="ghost">
              {t("operations.addToProject.viewReceipt")}
            </Button>
          </>
        }
      />
    </>
  );
}

export function CatalogueAssignmentWorkbench({
  api,
  auditReport,
  entry,
  marketplaceObservation,
  observations = {},
  onEnsureGrant,
  onMarketplaceChanged,
  onNavigateToRoute,
  projectId,
  projectName,
  returnTo,
}: CatalogueAssignmentWorkbenchProps): ReactElement {
  const { language, t } = useI18n();
  const packages = marketplaceObservation?.inventory.packages ?? [];
  const detectedHarnesses = useMemo(
    () =>
      observedForProject(projectId, observations, auditReport)?.inventory.harnesses.filter(
        (harness): harness is HarnessId => HARNESSES.includes(harness as HarnessId),
      ) ?? [],
    [auditReport, observations, projectId],
  );
  const [target, setTarget] = useState<Target>(() =>
    packages[0] ? { kind: "package", packageId: packages[0].id } : { kind: "new", name: entry.skill },
  );
  const [targetChosen, setTargetChosen] = useState(false);
  const [harnessIds, setHarnessIds] = useState<readonly HarnessId[]>(() =>
    detectedHarnesses.length ? detectedHarnesses : ["claude-code"],
  );
  const [harnessesChosen, setHarnessesChosen] = useState(false);
  const [preview, setPreview] = useState<OperationPlan | null>(null);
  const [receipt, setReceipt] = useState<OperationReceipt | null>(null);
  const [childReceipts, setChildReceipts] = useState<readonly OperationReceipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (targetChosen || !packages.length || (target.kind === "package" && target.packageId === packages[0]?.id)) return;
    setTarget({ kind: "package", packageId: packages[0].id });
  }, [packages, target, targetChosen]);

  useEffect(() => {
    if (harnessesChosen) return;
    setHarnessIds(detectedHarnesses.length ? detectedHarnesses : ["claude-code"]);
  }, [detectedHarnesses, harnessesChosen]);

  const selectedPackage = useMemo(
    () => (target.kind === "package" ? packages.find((item) => item.id === target.packageId) : undefined),
    [packages, target],
  );
  const packageName =
    selectedPackage?.displayName ?? (target.kind === "new" ? target.name : t("operations.import.newPackage"));

  useEffect(() => {
    let active = true;
    const previewOperation = api?.previewOperation;
    if (receipt) {
      return () => {
        active = false;
      };
    }
    if (!previewOperation || (target.kind === "new" && !target.name.trim()) || !harnessIds.length) {
      setPreview(null);
      return () => {
        active = false;
      };
    }
    setBusy(true);
    setError(null);
    void onEnsureGrant({ kind: "project", id: projectId })
      .then((grantHandle) => {
        if (!grantHandle) throw new Error(t("operations.addToProject.projectUnavailable"));
        return previewOperation({
          kind: "add-to-project" as const,
          entry,
          projectId,
          grantHandle,
          harnessIds,
          ...(target.kind === "package"
            ? { packageId: target.packageId }
            : {
                newPackageName: target.kind === "new" ? target.name : entry.skill,
                description: target.kind === "new" ? (target.description ?? "") : "",
              }),
        });
      })
      .then((result: PreviewMarketplaceResponse) => {
        if (!active) return;
        if (result.status === "ready") setPreview(result.plan);
        else setError(result.diagnostic);
      })
      .catch((previewError: unknown) => {
        if (active) setError(previewError instanceof Error ? previewError.message : t("operations.unavailable"));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, entry, harnessIds, onEnsureGrant, projectId, receipt, t, target]);

  const apply = async (): Promise<void> => {
    if (!api?.applyOperation || !preview) return;
    setBusy(true);
    try {
      const result = await api.applyOperation({ planId: preview.planId });
      setReceipt(result.receipt);
      setPreview(null);
      if (api.listOperations) {
        const listed = await api.listOperations();
        if (listed.status === "ready") {
          const childIds = new Set(result.receipt.children ?? []);
          setChildReceipts(listed.receipts.filter((candidate) => childIds.has(candidate.operationId)));
        }
      }
      if (result.status === "applied") onMarketplaceChanged?.();
      else setError(result.receipt.diagnostic ?? t("operations.failed"));
    } catch {
      setError(t("operations.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <WorkflowWorkbench
      title={t("operations.addToProject.title", { skill: entry.skill, project: projectName })}
      busy={busy}
      hasResult={Boolean(receipt)}
      onClose={() => onNavigateToRoute(returnTo)}
      receipt={receipt}
      onNavigate={onNavigateToRoute}
      targets={
        preview ? (
          <PlanCard
            entrySkill={entry.skill}
            language={language}
            packageName={packageName}
            plan={preview}
            projectName={projectName}
            t={t}
          />
        ) : null
      }
      footer={
        !receipt ? (
          <WorkflowFooter
            actions={
              <Button dataTestId="add-to-project-apply" disabled={busy || !preview} onClick={() => void apply()}>
                {t("operations.addToProject.apply", { project: projectName })}
              </Button>
            }
            note={t("operations.addToProject.confirmNote")}
          />
        ) : null
      }
      api={api}
    >
      <div data-testid="add-to-project-page">
        {receipt ? (
          <ResultCard
            childReceipts={childReceipts}
            onOpenProject={() => onNavigateToRoute({ screen: "project", projectId, tab: "overview" })}
            onViewReceipt={() =>
              onNavigateToRoute({
                screen: "operation-receipt",
                operationId: receipt.operationId,
                returnTo: { screen: "project", projectId, tab: "overview" },
              })
            }
            projectName={projectName}
            receipt={receipt}
            t={t}
          />
        ) : (
          <>
            <section>
              <SectionHeading title={t("operations.addToProject.marketplace")} />
              <MarketplacePackagePicker
                language={language}
                onChange={(next) => {
                  setTargetChosen(true);
                  setTarget(next);
                  setPreview(null);
                }}
                packages={packages}
                t={t}
                target={target}
                targetObservation={marketplaceObservation}
              />
            </section>
            <Card data-testid="add-to-project-project-card">
              <CardHeader title={t("operations.addToProject.project")} />
              <ItemList>
                {HARNESSES.map((harnessId) => {
                  const targetState = resolveHarnessTarget("skill", entry.skill, harnessId);
                  const disabled = targetState.status === "blocked";
                  return (
                    <HarnessCheckboxRow
                      blockedReason={targetState.status === "blocked" ? targetState.reason : undefined}
                      checkboxTestId={`add-to-project-harness-${harnessId}`}
                      dataTestId={`add-to-project-harness-${harnessId}`}
                      disabled={disabled}
                      harnessId={harnessId}
                      key={harnessId}
                      checked={harnessIds.includes(harnessId)}
                      onChange={() => {
                        setHarnessesChosen(true);
                        setHarnessIds((current) =>
                          current.includes(harnessId)
                            ? current.filter((item) => item !== harnessId)
                            : [...current, harnessId],
                        );
                      }}
                      t={t}
                    />
                  );
                })}
              </ItemList>
            </Card>

            {error ? (
              <Callout title={t("operations.failed")} tone="error">
                {error}
              </Callout>
            ) : null}
          </>
        )}
      </div>
    </WorkflowWorkbench>
  );
}
