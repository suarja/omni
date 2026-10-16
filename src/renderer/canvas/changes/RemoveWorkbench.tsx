import { WorkflowWorkbench } from "./WorkflowWorkbench";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import type { ApplyBlockedResponse, RemovePreviewResponse } from "../../../shared/apply-ipc";
import type { DesktopApi } from "../../../shared/ipc";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Callout";
import { Card, CardHeader } from "../../components/ui/Card";
import { WorkflowFooter } from "./WorkflowFooter";
import { ItemList, ListItem } from "../../components/ui/ItemList";
import { tCount, useI18n } from "../../i18n";
import type { Route } from "../../navigation";
import { CommitBadge, GitPreviewRow, UnifiedDiff } from "../../operations/lifecycle-ui";

type PreviewState = Readonly<
  { kind: "ready"; value: RemovePreviewResponse } | { kind: "blocked"; value: ApplyBlockedResponse }
>;

export type RemoveWorkbenchProps = Readonly<{
  api: Pick<DesktopApi, "previewRemove" | "runRemove"> | null;
  bindingId: string;
  projectId: string;
  projectName: string;
  unitName: string;
  onEnsureGrant: (ref: { kind: "project"; id: string }) => Promise<string | null>;
  onNavigateToRoute: (route: Route) => void;
  onProjectChanged: (projectId: string) => void;
}>;

export function RemoveWorkbench({
  api,
  bindingId,
  onEnsureGrant,
  onNavigateToRoute,
  onProjectChanged,
  projectId,
  projectName,
  unitName,
}: RemoveWorkbenchProps): ReactElement {
  const { language, t } = useI18n();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [result, setResult] = useState<OperationReceipt | null>(null);
  const [expanded, setExpanded] = useState<Readonly<Record<number, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const loadPreview = useCallback(async (): Promise<void> => {
    const current = sequence.current + 1;
    sequence.current = current;
    if (!api?.previewRemove) return;
    setBusy(true);
    try {
      const grantHandle = await onEnsureGrant({ kind: "project", id: projectId });
      if (!grantHandle) throw new Error(t("operations.lifecycle.grantUnavailable"));
      const response = await api.previewRemove({ bindingId, grantHandle });
      if (sequence.current !== current) return;
      setPreview(
        response.status === "ready" ? { kind: "ready", value: response } : { kind: "blocked", value: response },
      );
    } catch (previewError: unknown) {
      if (sequence.current === current)
        setError(previewError instanceof Error ? previewError.message : t("operations.unavailable"));
    } finally {
      if (sequence.current === current) setBusy(false);
    }
  }, [api, bindingId, onEnsureGrant, projectId, t]);
  useEffect(() => {
    void loadPreview();
    return () => {
      sequence.current += 1;
    };
  }, [loadPreview]);

  const run = async (): Promise<void> => {
    if (!api?.runRemove || preview?.kind !== "ready") return;
    setBusy(true);
    try {
      const response = await api.runRemove({ planId: preview.value.planId });
      if (response.status === "blocked") {
        setPreview({ kind: "blocked", value: response });
        return;
      }
      setResult(response.receipt);
      if (response.status === "applied") onProjectChanged(projectId);
      else setError(response.receipt.diagnostic ?? t("operations.failed"));
    } catch (runError: unknown) {
      setError(runError instanceof Error ? runError.message : t("operations.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  if (result)
    return (
      <WorkflowWorkbench
        title={t("operations.lifecycle.removeHeading", { unit: unitName, project: projectName })}
        busy={busy}
        hasResult={Boolean(result)}
        onClose={() => onNavigateToRoute({ screen: "review" })}
        receipt={result}
        onNavigate={onNavigateToRoute}
        footer={
          <WorkflowFooter
            actions={
              <Button onClick={() => onNavigateToRoute({ screen: "project", projectId, tab: "review" })}>
                {t("operations.lifecycle.backToProject")}
              </Button>
            }
          />
        }
        api={api}
      >
        <div data-testid="remove-result">
          {result.status === "applied" ? (
            <Card>
              <CardHeader
                count={<CommitBadge receipt={result} />}
                title={tCount(
                  "operations.lifecycle.filesRemoved",
                  result.files?.length ?? result.actions.length,
                  {},
                  language,
                )}
              />
            </Card>
          ) : (
            <Callout title={t("operations.failed")} tone="error">
              {result.diagnostic ?? error ?? t("operations.failed")}
            </Callout>
          )}
        </div>
      </WorkflowWorkbench>
    );
  return (
    <WorkflowWorkbench
      title={t("operations.lifecycle.removeHeading", { unit: unitName, project: projectName })}
      busy={busy}
      hasResult={Boolean(result)}
      onClose={() => onNavigateToRoute({ screen: "review" })}
      receipt={result}
      onNavigate={onNavigateToRoute}
      targets={
        preview?.kind === "ready" ? (
          <Card dataTestId="remove-effects">
            <CardHeader title={t("operations.lifecycle.whatWillBeRemoved")} />
            <ItemList>
              {preview.value.files.map((file) => (
                <ListItem
                  key={file.relativePath}
                  name={<code>{file.relativePath}</code>}
                  side={
                    file.modified ? (
                      <Badge tone="warn" variant="status">
                        {t("operations.lifecycle.modified")}
                      </Badge>
                    ) : undefined
                  }
                />
              ))}
            </ItemList>
            <p className="lifecycle-note">{t("operations.lifecycle.modifiedNote")}</p>
            <GitPreviewRow git={preview.value.git} />
          </Card>
        ) : null
      }
      footer={
        <WorkflowFooter
          note={t("operations.lifecycle.removeNote")}
          actions={
            <Button dataTestId="remove-run" disabled={busy || preview?.kind !== "ready"} onClick={() => void run()}>
              {t("operations.lifecycle.remove")}
            </Button>
          }
        />
      }
      api={api}
    >
      <div data-testid="remove-page">
        {error ? (
          <Callout title={t("operations.lifecycle.previewUnavailable")} tone="error">
            {error}
          </Callout>
        ) : null}
        {preview?.kind === "blocked" ? (
          <Callout title={t("operations.lifecycle.removeBlocked")} tone="warning">
            {preview.value.reason}
            {preview.value.diagnostic ? `: ${preview.value.diagnostic}` : ""}
            <div>
              <Button dataTestId="remove-preview-again" onClick={() => void loadPreview()} tone="ghost" size="small">
                {t("operations.lifecycle.previewAgain")}
              </Button>
            </div>
          </Callout>
        ) : null}
        {preview?.kind === "ready" ? (
          <Card>
            <CardHeader title={t("operations.lifecycle.whatWillBeRemoved")} />
            <ItemList>
              {preview.value.files.map((file, index) => (
                <div className="lifecycle-action" key={file.relativePath}>
                  <ListItem
                    name={<code>{file.relativePath}</code>}
                    side={
                      file.modified ? (
                        <Badge tone="warn" variant="status">
                          {t("operations.lifecycle.modified")}
                        </Badge>
                      ) : undefined
                    }
                  />
                  <div className="lifecycle-choice">
                    {file.modified && file.diff ? (
                      <>
                        <Button
                          dataTestId={`remove-diff-${index}`}
                          ariaExpanded={Boolean(expanded[index])}
                          onClick={() => setExpanded((current) => ({ ...current, [index]: !current[index] }))}
                          size="small"
                          tone="ghost"
                        >
                          {t("operations.lifecycle.showDiff")}
                        </Button>
                        {expanded[index] ? <UnifiedDiff text={file.diff.text} truncated={file.diff.truncated} /> : null}
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </ItemList>
            <p className="lifecycle-note">{t("operations.lifecycle.modifiedNote")}</p>
            <GitPreviewRow git={preview.value.git} />
          </Card>
        ) : null}
      </div>
    </WorkflowWorkbench>
  );
}
