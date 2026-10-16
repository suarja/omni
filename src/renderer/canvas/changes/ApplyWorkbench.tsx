import { WorkflowWorkbench } from "./WorkflowWorkbench";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { RegistryEntryView } from "../../../domain/project-source-registry";
import type { ApplyPreviewAction, ApplyPreviewResponse, ApplyBlockedResponse } from "../../../shared/apply-ipc";
import type { DesktopApi } from "../../../shared/ipc";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Callout";
import { Card, CardHeader } from "../../components/ui/Card";
import { WorkflowFooter } from "./WorkflowFooter";
import { ItemList, ListItem } from "../../components/ui/ItemList";
import { tCount, useI18n } from "../../i18n";
import type { Route } from "../../navigation";
import { CommitBadge, GitPreviewRow, UnifiedDiff } from "../../operations/lifecycle-ui";

type Project = RegistryEntryView<"project">;
type PreviewState = Readonly<
  { kind: "ready"; value: ApplyPreviewResponse } | { kind: "blocked"; value: ApplyBlockedResponse }
>;
type Resolution = "keep-mine" | "take-marketplace";

export type ApplyWorkbenchProps = Readonly<{
  api: Pick<DesktopApi, "previewApply" | "runApply"> | null;
  project: Project;
  sourceId: string;
  bindingIds?: readonly string[];
  onEnsureGrant: (ref: { kind: "project" | "source"; id: string }) => Promise<string | null>;
  onNavigateToRoute: (route: Route) => void;
  onProjectChanged: (projectId: string) => void;
}>;

function harnessName(harness: ApplyPreviewAction["harnessId"], t: ReturnType<typeof useI18n>["t"]): string {
  return t(`operations.harness.${harness === "claude-code" ? "claudeCode" : harness}` as Parameters<typeof t>[0]);
}

function stateTone(state: ApplyPreviewAction["state"]): BadgeTone {
  if (state === "update") return "warn";
  if (state === "conflict") return "bad";
  return "neutral";
}

function actionLabel(state: ApplyPreviewAction["state"], t: ReturnType<typeof useI18n>["t"]): string {
  return t(`assignment.${state}` as Parameters<typeof t>[0]);
}

function ApplyAction({
  action,
  onCapture,
  resolution,
  onResolution,
  onToggleDiff,
  showDiff,
  t,
}: Readonly<{
  action: ApplyPreviewAction;
  onCapture: () => void;
  resolution?: Resolution;
  onResolution: (choice: Resolution) => void;
  onToggleDiff: () => void;
  showDiff: boolean;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  const conflict = action.state === "conflict";
  return (
    <div
      className={`lifecycle-action${conflict ? " lifecycle-action--conflict" : ""}`}
      data-testid={`apply-action-${action.actionId}`}
    >
      <ListItem
        leading={<Badge variant="type">{harnessName(action.harnessId, t)}</Badge>}
        name={<code>{action.relativePath}</code>}
        side={
          <Badge tone={stateTone(action.state)} variant="status">
            {actionLabel(action.state, t)}
          </Badge>
        }
        sub={action.reason}
      />
      {conflict ? (
        <div className="lifecycle-choice">
          <ItemList>
            <ListItem
              ariaPressed={resolution === "keep-mine"}
              dataTestId={`apply-choice-${action.actionId}-keep-mine`}
              name={t("operations.lifecycle.keepMine")}
              selected={resolution === "keep-mine"}
              onClick={() => onResolution("keep-mine")}
            />
            <ListItem
              ariaPressed={resolution === "take-marketplace"}
              dataTestId={`apply-choice-${action.actionId}-take-marketplace`}
              name={t("operations.lifecycle.takeMarketplace")}
              selected={resolution === "take-marketplace"}
              onClick={() => onResolution("take-marketplace")}
            />
          </ItemList>
          <Button
            onClick={() => onToggleDiff()}
            ariaExpanded={showDiff}
            dataTestId={`apply-diff-${action.actionId}`}
            tone="ghost"
            size="small"
          >
            {t("operations.lifecycle.showDiff")}
          </Button>
          {action.diff && showDiff ? <UnifiedDiff text={action.diff.text} truncated={action.diff.truncated} /> : null}
          <button className="lifecycle-link" onClick={onCapture} type="button">
            {t("operations.lifecycle.captureMine")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function receiptSummary(
  receipt: OperationReceipt,
  resolutions: Readonly<Record<string, Resolution>>,
  actions: readonly ApplyPreviewAction[],
  t: ReturnType<typeof useI18n>["t"],
  language: "en" | "fr",
): string {
  const written =
    receipt.files?.length ??
    receipt.actions.filter((action) => action.status === "applied" && action.kind === "write-file").length;
  const kept = actions.filter(
    (action) => action.state === "current" || action.state === "linked" || resolutions[action.actionId] === "keep-mine",
  ).length;
  const summary = [tCount("operations.lifecycle.filesWritten", written, {}, language)];
  if (kept > 0) summary.push(tCount("operations.lifecycle.kept", kept, {}, language));
  summary.push(t("operations.lifecycle.backupsSaved"));
  return summary.join(" · ");
}

export function ApplyWorkbench({
  api,
  onEnsureGrant,
  onNavigateToRoute,
  onProjectChanged,
  project,
  sourceId,
  bindingIds,
}: ApplyWorkbenchProps): ReactElement {
  const { language, t } = useI18n();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [result, setResult] = useState<OperationReceipt | null>(null);
  const [resolutions, setResolutions] = useState<Readonly<Record<string, Resolution>>>({});
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const loadPreview = useCallback(async (): Promise<void> => {
    const requestSequence = sequence.current + 1;
    sequence.current = requestSequence;
    if (!api?.previewApply) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const projectGrant = await onEnsureGrant({ kind: "project", id: project.ref.id });
      const sourceGrant = await onEnsureGrant({ kind: "source", id: sourceId });
      if (!projectGrant || !sourceGrant) throw new Error(t("operations.lifecycle.grantUnavailable"));
      const response = await api.previewApply({
        projectId: project.ref.id,
        grantHandle: projectGrant,
        sourceGrantHandle: sourceGrant,
        ...(bindingIds ? { bindingIds } : {}),
      });
      if (sequence.current !== requestSequence) return;
      setPreview(
        response.status === "ready" ? { kind: "ready", value: response } : { kind: "blocked", value: response },
      );
    } catch (previewError: unknown) {
      if (sequence.current === requestSequence)
        setError(previewError instanceof Error ? previewError.message : t("operations.unavailable"));
    } finally {
      if (sequence.current === requestSequence) setBusy(false);
    }
  }, [api, bindingIds, onEnsureGrant, project.ref.id, sourceId, t]);

  useEffect(() => {
    void loadPreview();
    return () => {
      sequence.current += 1;
    };
  }, [loadPreview]);

  const actions = preview?.kind === "ready" ? preview.value.actions : [];
  const blocked = preview?.kind === "ready" && preview.value.actions.some((action) => action.state === "blocked");
  const unresolved = actions.some((action) => action.needsResolution && !resolutions[action.actionId]);
  const harnesses = useMemo(
    () => [...new Set(actions.map((action) => harnessName(action.harnessId, t)))].join(", "),
    [actions, t],
  );
  const run = async (): Promise<void> => {
    if (!api?.runApply || preview?.kind !== "ready" || blocked || unresolved) return;
    setBusy(true);
    try {
      const response = await api.runApply({
        planId: preview.value.planId,
        resolutions: Object.entries(resolutions).map(([actionId, choice]) => ({ actionId, choice })),
      });
      if (response.status === "blocked") {
        setPreview({ kind: "blocked", value: response });
        return;
      }
      setResult(response.receipt);
      if (response.status === "applied") onProjectChanged(project.ref.id);
      else setError(response.receipt.diagnostic ?? t("operations.failed"));
    } catch (runError: unknown) {
      setError(runError instanceof Error ? runError.message : t("operations.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  if (result?.status === "failed")
    return (
      <WorkflowWorkbench
        title={t("operations.lifecycle.applyHeading", { project: project.displayName })}
        subtitle={tCount("operations.lifecycle.changesFor", actions.length, { harnesses }, language)}
        busy={busy}
        hasResult={Boolean(result)}
        onClose={() => onNavigateToRoute({ screen: "review" })}
        receipt={result}
        onNavigate={onNavigateToRoute}
        footer={
          <WorkflowFooter
            actions={
              <>
                <Button
                  onClick={() =>
                    onNavigateToRoute({ screen: "operation-restore-apply", operationId: result.operationId })
                  }
                  tone="ghost"
                >
                  {t("operations.lifecycle.restore")}
                </Button>
                <Button onClick={() => onNavigateToRoute({ screen: "review" })} tone="ghost">
                  {t("operations.backToReview")}
                </Button>
              </>
            }
          />
        }
        api={api}
      >
        <div data-testid="apply-page">
          <Callout title={t("operations.failed")} tone="error">
            {result.diagnostic ?? t("operations.failedReceipt", { status: result.status })}
          </Callout>
        </div>
      </WorkflowWorkbench>
    );
  if (result)
    return (
      <WorkflowWorkbench
        title={t("operations.lifecycle.applyHeading", { project: project.displayName })}
        subtitle={tCount("operations.lifecycle.changesFor", actions.length, { harnesses }, language)}
        busy={busy}
        hasResult={Boolean(result)}
        onClose={() => onNavigateToRoute({ screen: "review" })}
        receipt={result}
        onNavigate={onNavigateToRoute}
        footer={
          <WorkflowFooter
            actions={
              <>
                <Button
                  onClick={() => onNavigateToRoute({ screen: "project", projectId: project.ref.id, tab: "review" })}
                >
                  {t("operations.lifecycle.openProject")}
                </Button>
                <Button onClick={() => onNavigateToRoute({ screen: "review" })} tone="ghost">
                  {t("operations.backToReview")}
                </Button>
              </>
            }
          />
        }
        api={api}
      >
        <div data-testid="apply-result">
          <Card>
            <CardHeader
              count={<CommitBadge receipt={result} />}
              title={receiptSummary(result, resolutions, actions, t, language)}
            />
          </Card>
        </div>
      </WorkflowWorkbench>
    );
  return (
    <WorkflowWorkbench
      title={t("operations.lifecycle.applyHeading", { project: project.displayName })}
      subtitle={tCount("operations.lifecycle.changesFor", actions.length, { harnesses }, language)}
      busy={busy}
      hasResult={Boolean(result)}
      onClose={() => onNavigateToRoute({ screen: "review" })}
      receipt={result}
      onNavigate={onNavigateToRoute}
      targets={
        preview?.kind === "ready" ? (
          <Card dataTestId="apply-effects">
            <CardHeader title={t("operations.lifecycle.whatWillChange")} />
            <ItemList>
              {actions.map((action) => (
                <ListItem
                  key={action.actionId}
                  name={<code>{action.relativePath}</code>}
                  sub={harnessName(action.harnessId, t)}
                  side={
                    <Badge variant="status" tone={stateTone(action.state)}>
                      {resolutions[action.actionId]
                        ? t(
                            `operations.lifecycle.${resolutions[action.actionId] === "keep-mine" ? "keepMine" : "takeMarketplace"}`,
                          )
                        : actionLabel(action.state, t)}
                    </Badge>
                  }
                />
              ))}
            </ItemList>
            <GitPreviewRow git={preview.value.git} />
          </Card>
        ) : null
      }
      footer={
        <WorkflowFooter
          note={t("operations.confirmNote")}
          actions={
            <Button
              dataTestId="apply-run"
              disabled={busy || !preview || preview.kind !== "ready" || blocked || unresolved}
              onClick={() => void run()}
            >
              {t("operations.lifecycle.apply")}
            </Button>
          }
        />
      }
      api={api}
    >
      <div data-testid="apply-page">
        {error ? (
          <Callout title={t("operations.lifecycle.previewUnavailable")} tone="error">
            {error}
          </Callout>
        ) : null}
        {preview?.kind === "blocked" ? (
          <Callout title={t("operations.lifecycle.applyBlocked")} tone="warning">
            {preview.value.reason}
            {preview.value.diagnostic ? `: ${preview.value.diagnostic}` : ""}
            <div>
              <Button dataTestId="apply-preview-again" onClick={() => void loadPreview()} tone="ghost" size="small">
                {t("operations.lifecycle.previewAgain")}
              </Button>
            </div>
          </Callout>
        ) : null}
        {preview?.kind === "ready" ? (
          <Card>
            <CardHeader
              hint={
                <Badge
                  tone={
                    blocked
                      ? "neutral"
                      : preview.value.actions.some((action) => action.state === "conflict")
                        ? "bad"
                        : "neutral"
                  }
                  variant="status"
                >
                  {actionLabel(
                    blocked
                      ? "blocked"
                      : preview.value.actions.some((action) => action.state === "conflict")
                        ? "conflict"
                        : "current",
                    t,
                  )}
                </Badge>
              }
              title={t("operations.lifecycle.whatWillChange")}
            />{" "}
            <ItemList>
              {actions.map((action) => (
                <ApplyAction
                  action={action}
                  key={action.actionId}
                  onCapture={() =>
                    onNavigateToRoute({
                      screen: "operation-import",
                      source: { kind: "project", id: project.ref.id },
                      relativePath: action.relativePath,
                      returnTo: { screen: "operation-apply", projectId: project.ref.id },
                    })
                  }
                  onResolution={(choice) => setResolutions((current) => ({ ...current, [action.actionId]: choice }))}
                  onToggleDiff={() =>
                    setExpanded((current) => ({ ...current, [action.actionId]: !current[action.actionId] }))
                  }
                  resolution={resolutions[action.actionId]}
                  showDiff={Boolean(expanded[action.actionId])}
                  t={t}
                />
              ))}
            </ItemList>
            <GitPreviewRow git={preview.value.git} />
          </Card>
        ) : null}
      </div>
    </WorkflowWorkbench>
  );
}
