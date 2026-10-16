import { WorkflowWorkbench } from "./WorkflowWorkbench";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { ObservedArtifact } from "../../../domain/inventory";
import type { EntryRef, Observation } from "../../../domain/project-source-registry";
import type { DesktopApi } from "../../../shared/ipc";
import type { OperationPlan, OperationReceipt, PreviewMarketplaceResponse } from "../../../shared/operations-ipc";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Callout";
import { Card, CardHeader } from "../../components/ui/Card";
import { WorkflowFooter } from "./WorkflowFooter";
import { ItemList, ListItem } from "../../components/ui/ItemList";
import { SectionHeading } from "../../components/ui/SectionHeading";
import { useI18n, tCount } from "../../i18n";
import { artifactName } from "../../../domain/identity";
import { slugify } from "../../../domain/marketplace-format";
import type { Harness } from "../../../domain/harness-projection";
import {
  importTitle,
  preferredArtifactPath,
  projectionHarnesses,
  targetIsValid,
} from "../../operations/operations-import-plan";
import type { Target } from "../../operations/operations-import-plan";
import { ImportPreview, ProjectionChoices } from "../../operations/ImportArtifactPreview";
import { HarnessBadges, MarketplacePackagePicker } from "../../operations/ImportArtifactChoices";
import type { Route } from "../../navigation";
import { samePlan } from "../../../shared/agent-plan-freshness";
import { useAgentRequestPreview } from "../../operations/use-agent-request-preview";
import { AgentPreviewUpdated } from "../../operations/AgentPreviewUpdated";
import { AgentRequestBanner } from "../../operations/AgentRequestBanner";

type PreviewState = Readonly<
  { kind: "ready"; plan: OperationPlan } | { kind: "blocked"; reason: string; diagnostic: string }
>;

export type ImportWorkbenchProps = Readonly<{
  api: DesktopApi | null;
  artifact: ObservedArtifact | null;
  sourcePath?: string;
  origin: EntryRef;
  originName: string;
  originPackageName?: string;
  returnTo: Route;
  sourceGrantHandle?: string;
  targetSourceId?: string;
  targetObservation: Observation | null;
  onMarketplaceChanged: () => void;
  onNavigateToRoute: (route: Route) => void;
  requestId?: string;
}>;

export function ImportWorkbench({
  api,
  artifact,
  sourcePath,
  origin,
  originName,
  originPackageName,
  returnTo,
  sourceGrantHandle,
  targetSourceId,
  targetObservation,
  onMarketplaceChanged,
  onNavigateToRoute,
  requestId,
}: ImportWorkbenchProps): ReactElement {
  const { language, t } = useI18n();
  const agentPreview = useAgentRequestPreview(api, requestId);
  const packages = targetObservation?.inventory.packages ?? [];
  const [target, setTarget] = useState<Target>({ kind: "none" });
  const [projections, setProjections] = useState<readonly Harness[]>(() => projectionHarnesses(targetObservation));
  const [agentTargetLoaded, setAgentTargetLoaded] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [receipt, setReceipt] = useState<OperationReceipt | null>(null);
  const [appliedVisibleIn, setAppliedVisibleIn] = useState<readonly ("omni" | Harness)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const previewSequence = useRef(0);
  const selectedPackage =
    target.kind === "package" ? packages.find((packageInfo) => packageInfo.id === target.packageId) : undefined;
  const valid = Boolean(artifact && sourceGrantHandle && targetIsValid(target));
  const name = artifact
    ? artifactName({ kind: artifact.kind, provenance: { relativePath: preferredArtifactPath(artifact) } })
    : sourcePath
      ? artifactName({ kind: "skill", provenance: { relativePath: sourcePath } })
      : "";
  const title = name
    ? importTitle(origin, name, t)
    : t(origin.kind === "project" ? "operations.import.capture" : "operations.import.import");
  const targetLabel =
    selectedPackage?.displayName ?? (target.kind === "new" ? target.name : t("operations.import.newPackage"));
  const marketplaceName =
    targetObservation?.inventory.marketplace?.name ??
    targetObservation?.inventory.displayRoot ??
    t("library.myMarketplace");
  const currentProjections = useMemo(() => projectionHarnesses(targetObservation), [targetObservation]);

  const requested = agentPreview.request?.request;
  const matchesTarget =
    requested?.kind === "import-artifact" &&
    (target.kind === "package"
      ? requested.target.packageId === target.packageId
      : target.kind === "new" &&
        requested.target.newPackageName === target.name &&
        JSON.stringify([...projections].sort()) ===
          JSON.stringify([...(requested.target.projectTo ?? currentProjections)].sort()));

  useEffect(() => {
    const requested = agentPreview.request?.request;
    if (requested?.kind !== "import-artifact") return;
    setTarget(
      requested.target.packageId
        ? { kind: "package", packageId: requested.target.packageId }
        : { kind: "new", name: requested.target.newPackageName ?? "", description: requested.target.description ?? "" },
    );
    if (requested.target.projectTo) setProjections(requested.target.projectTo);
    setAgentTargetLoaded(true);
  }, [agentPreview.request]);

  useEffect(() => {
    if (target.kind === "new" && !agentTargetLoaded) setProjections(currentProjections);
  }, [agentTargetLoaded, currentProjections, target.kind]);

  useEffect(() => {
    if (requestId && (agentPreview.busy || agentPreview.error || matchesTarget)) {
      const plan = agentPreview.request?.plan;
      setPreview(plan && plan.kind !== "assign" ? { kind: "ready", plan } : null);
      setError(agentPreview.error);
      return;
    }
    if (!valid || !artifact || !sourceGrantHandle || !api?.previewOperation) {
      setPreview(null);
      return;
    }
    const sequence = previewSequence.current + 1;
    previewSequence.current = sequence;
    if (target.kind === "none") return;
    const request =
      target.kind === "package"
        ? {
            kind: "import-artifact" as const,
            source: { kind: origin.kind, id: origin.id, grantHandle: sourceGrantHandle },
            relativePath: sourcePath ?? artifact.relativePath,
            target: { packageId: target.packageId },
          }
        : {
            kind: "import-artifact" as const,
            source: { kind: origin.kind, id: origin.id, grantHandle: sourceGrantHandle },
            relativePath: sourcePath ?? artifact.relativePath,
            target: {
              newPackageName: target.name,
              description: target.description ?? "",
              ...((projections.length ? projections : currentProjections).length
                ? { projectTo: projections.length ? projections : currentProjections }
                : {}),
            },
          };
    const previewOperation = api.previewOperation;
    if (!previewOperation) return;
    const runPreview = (): void => {
      setBusy(true);
      setError(null);
      void previewOperation(request)
        .then((result: PreviewMarketplaceResponse) => {
          if (sequence !== previewSequence.current) return;
          setPreview(
            result.status === "ready"
              ? { kind: "ready", plan: result.plan }
              : { kind: "blocked", reason: result.reason, diagnostic: result.diagnostic },
          );
        })
        .catch(() => {
          if (sequence === previewSequence.current) setError(t("operations.unavailable"));
        })
        .finally(() => {
          if (sequence === previewSequence.current) setBusy(false);
        });
    };
    if (target.kind === "package") {
      runPreview();
      return;
    }
    const timer = window.setTimeout(runPreview, 300);
    return () => window.clearTimeout(timer);
  }, [
    api,
    artifact,
    origin,
    projections,
    sourceGrantHandle,
    sourcePath,
    t,
    target,
    valid,
    requestId,
    agentPreview.request,
    agentPreview.error,
    agentPreview.busy,
    matchesTarget,
  ]);

  const apply = async (): Promise<void> => {
    if (!api?.applyOperation || preview?.kind !== "ready" || busy || agentPreview.busy) return;
    setBusy(true);
    try {
      let plan = preview.plan;
      if (requestId && matchesTarget) {
        const fresh = await agentPreview.refresh();
        if (!fresh || fresh.plan.kind === "assign") return;
        plan = fresh.plan;
        if (!samePlan(preview.plan, plan)) {
          setPreview({ kind: "ready", plan });
          agentPreview.markUpdated();
          return;
        }
      }
      const result = await api.applyOperation({ planId: plan.planId });
      setReceipt(result.receipt);
      setAppliedVisibleIn(preview.plan.visibleIn ?? []);
      setPreview(null);
      if (result.status === "applied") {
        onMarketplaceChanged();
        if (requestId) await api.resolveAgentRequest?.({ requestId, operationId: result.receipt.operationId });
      } else setError(t("operations.failedReceipt", { status: result.receipt.status }));
    } catch {
      setError(t("operations.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  if (!artifact)
    return (
      <WorkflowWorkbench
        title={title}
        subtitle={originName}
        busy={busy || agentPreview.busy}
        hasResult={Boolean(receipt)}
        onClose={() => onNavigateToRoute(returnTo)}
        receipt={receipt}
        onNavigate={onNavigateToRoute}
        api={api}
      >
        <div>
          <Card>
            <ItemList variant="nested">
              <ListItem dim name={t("operations.import.artifactUnavailable")} />
            </ItemList>
          </Card>
        </div>
      </WorkflowWorkbench>
    );
  return (
    <WorkflowWorkbench
      title={title}
      subtitle={
        artifact
          ? `${t(`registry.artifactKinds.${artifact.kind}` as Parameters<typeof t>[0])} · ${[originName, originPackageName].filter(Boolean).join(" / ")} · ${preferredArtifactPath(artifact)}`
          : originName
      }
      busy={busy || agentPreview.busy}
      hasResult={Boolean(receipt)}
      onClose={() => onNavigateToRoute(returnTo)}
      receipt={receipt}
      onNavigate={onNavigateToRoute}
      targets={
        preview?.kind === "ready" && artifact ? (
          <ImportPreview
            artifact={artifact}
            language={language}
            marketplaceName={marketplaceName}
            packageName={targetLabel}
            plan={preview.plan}
            t={t}
          />
        ) : null
      }
      footer={
        !receipt ? (
          <>
            {preview?.kind === "blocked" ? (
              <WorkflowFooter note={`${preview.reason}: ${preview.diagnostic}`} />
            ) : preview?.kind === "ready" ? (
              <>
                <WorkflowFooter
                  actions={
                    <Button dataTestId="import-apply" disabled={busy || agentPreview.busy} onClick={() => void apply()}>
                      {origin.kind === "project" ? t("operations.import.capture") : t("operations.import.import")}
                    </Button>
                  }
                  note={t("operations.confirmNote")}
                />
              </>
            ) : null}
          </>
        ) : null
      }
      api={api}
      notice={
        <>
          <AgentRequestBanner api={api} requestId={requestId} applying={busy || agentPreview.busy} />
          <AgentPreviewUpdated visible={agentPreview.updated} />
        </>
      }
    >
      <div data-testid="import-artifact-page">
        {!receipt ? (
          <>
            <section aria-label={t("operations.import.package")} data-testid="import-target-section">
              <SectionHeading
                hint={t("operations.import.marketplaceHint", { name: marketplaceName })}
                title={t("operations.import.package")}
              />
              <MarketplacePackagePicker
                language={language}
                onChange={(next) => {
                  setTarget(next);
                  setPreview(null);
                  setReceipt(null);
                  setAppliedVisibleIn([]);
                }}
                packages={packages}
                t={t}
                target={target}
                targetObservation={targetObservation}
              />
              {target.kind === "new" ? (
                <ProjectionChoices
                  available={currentProjections}
                  selected={projections}
                  onChange={(harness, checked) =>
                    setProjections((current) =>
                      checked ? [...current, harness] : current.filter((item) => item !== harness),
                    )
                  }
                  t={t}
                />
              ) : null}
            </section>
            {error ? (
              <Callout title={t("operations.failed")} tone="error">
                {error}
              </Callout>
            ) : null}
          </>
        ) : null}
        {receipt && receipt.status !== "applied" ? (
          <Callout title={t("operations.failed")} tone="error">
            {receipt.diagnostic ?? error ?? t("operations.failedReceipt", { status: receipt.status })}
          </Callout>
        ) : null}
        {receipt?.status === "applied" ? (
          <>
            <div data-testid="import-result">
              <Card>
                <CardHeader
                  title={t("operations.import.result")}
                  count={
                    <Badge tone="ok" variant="status">
                      {t("operations.applied")}
                    </Badge>
                  }
                />
                <ItemList variant="nested">
                  <ListItem
                    name={tCount(
                      "operations.import.filesWrittenIn",
                      receipt.files?.length ?? 0,
                      // The receipt names the package it wrote into; the selection may be gone after the refresh.
                      { package: receipt.displayTarget.split("/").at(-1) || targetLabel },
                      language,
                    )}
                  />
                  <ListItem
                    name={t("operations.commit")}
                    side={
                      receipt.git.commit ? (
                        <Badge dataTestId="import-result-commit" variant="count">
                          {receipt.git.commit.slice(0, 7)}
                        </Badge>
                      ) : (
                        <span>{t("operations.noCommit")}</span>
                      )
                    }
                  />
                  <ListItem
                    name={
                      <span className="import-visible-in">
                        <span>{t("operations.preview.visibleIn")}</span>
                        <HarnessBadges harnesses={appliedVisibleIn} t={t} />
                      </span>
                    }
                  />
                </ItemList>
              </Card>
            </div>
            <div data-testid="import-result-footer">
              <WorkflowFooter
                actions={
                  <>
                    <Button
                      dataTestId="import-result-open"
                      onClick={() =>
                        onNavigateToRoute({
                          screen: "package",
                          sourceId: targetObservation?.subject.id ?? targetSourceId ?? "",
                          packageId: selectedPackage?.id ?? slugify(targetLabel),
                        })
                      }
                    >
                      {t("operations.openMarketplace")}
                    </Button>
                    <Button onClick={() => onNavigateToRoute(returnTo)} tone="ghost">
                      {t("operations.back")}
                    </Button>
                  </>
                }
              />
            </div>
          </>
        ) : null}
      </div>
    </WorkflowWorkbench>
  );
}
