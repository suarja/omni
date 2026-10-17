import { WorkflowWorkbench } from "./WorkflowWorkbench";
import { useEffect, useState, type ReactElement } from "react";

import type { DesktopApi } from "../../../shared/ipc";
import type { ApplyBlockedResponse, RestorePreviewResponse } from "../../../shared/apply-ipc";
import type {
  OperationAction,
  OperationPlan,
  OperationReceipt,
  PreviewMarketplaceResponse,
} from "../../../shared/operations-ipc";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Callout";
import { Card, CardHeader } from "../../components/ui/Card";
import { WorkflowFooter } from "./WorkflowFooter";
import { ItemList, ListItem } from "../../components/ui/ItemList";
import { LoadingSkeleton } from "../../components/ui/Skeleton";
import { tCount, useI18n } from "../../i18n";
import type { Route } from "../../navigation";

type PreviewState = Readonly<
  { kind: "ready"; plan: OperationPlan } | { kind: "blocked"; reason: string; diagnostic: string }
>;

export type RestoreWorkbenchProps = Readonly<{
  api: DesktopApi | null;
  operationId: string;
  onApplyingChange?: (active: boolean) => void;
  onMarketplaceChanged?: () => void;
  onProjectChanged?: (projectId: string) => void;
  onNavigateToRoute: (route: Route) => void;
}>;

function artifactLabel(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  for (const folder of ["skills", "commands", "agents", "hooks"]) {
    const index = parts.indexOf(folder);
    if (index >= 0 && parts[index + 1]) return parts[index + 1];
  }
  return (parts.at(-1) ?? path).replace(/\.[^.]+$/u, "");
}
function packageName(target: string): string {
  return target.replaceAll("\\", "/").split("/").at(-1) ?? target;
}

function relativePath(path: string, target: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedTarget = target.replaceAll("\\", "/").replace(/\/$/u, "");
  return normalizedPath.startsWith(`${normalizedTarget}/`)
    ? normalizedPath.slice(normalizedTarget.length + 1)
    : normalizedPath;
}

function actionLabel(
  action: OperationAction,
  t: ReturnType<typeof useI18n>["t"],
  providerSettings: boolean,
  harnessSetting: boolean,
): string {
  if (action.kind === "delete-directory") return t("operations.restore.deleteFolder", { path: action.relativePath });
  if (action.kind === "delete-file") return t("operations.restore.deleteFile", { path: action.relativePath });
  if (harnessSetting) return t("operations.restore.harnessSettingFile", { path: action.relativePath });
  if (providerSettings) return t("operations.restore.registerMcpFile", { path: action.relativePath });
  return t("operations.restore.restoreManifest", { path: action.relativePath });
}

function deleteFileCount(plan: OperationPlan): number {
  return plan.actions.filter((action) => action.kind === "delete-file").length;
}

// A manifest is "restored" when its previous content is written back; a created one is deleted.
function manifestCount(plan: OperationPlan): number {
  return plan.actions.filter((action) => action.manifest && action.kind === "write-file").length;
}

// The composite's display target is "<skill> → <package> → <project>" (`operations-add-to-project.ts`).
function compositeParts(target: string): Readonly<{ skill: string; package: string; project: string }> {
  const [skill = target, packageName = "", project = ""] = target.split(" → ");
  return { skill, package: packageName, project };
}

function RestorePreview({
  language,
  plan,
  t,
}: Readonly<{ language: "en" | "fr"; plan: OperationPlan; t: ReturnType<typeof useI18n>["t"] }>): ReactElement {
  if (plan.kind === "archive-project")
    return (
      <Card>
        <CardHeader title={t("agents.archiveProject", { name: plan.displayTarget })} />
        <p>{t("agents.projectRegistrationEffect")}</p>
      </Card>
    );
  const lifecycle =
    plan.kind === "restore-apply" ||
    plan.kind === "remove-binding" ||
    plan.kind === "write-skill" ||
    plan.kind === "register-mcp" ||
    plan.kind === "restore-add-to-project";
  const harnessSetting = plan.displayTarget.split(" · ").some((target) => target === "~/.claude/settings.json");
  const providerSettings =
    harnessSetting ||
    plan.displayTarget.split(" · ").some((target) => target === "~/.claude.json" || target === "~/.codex/config.toml");
  const visibleActions = lifecycle
    ? plan.actions
    : plan.actions.filter(
        (action) =>
          (action.kind === "delete-file" && !action.manifest) || (providerSettings && action.kind === "write-file"),
      );
  const settingsWriteCount = plan.actions.filter((action) => action.kind === "write-file").length;
  return (
    <Card>
      <CardHeader title={t("operations.restore.preview")} />
      <ItemList variant="nested">
        <ListItem
          name={
            lifecycle
              ? tCount("operations.lifecycle.filesRestored", visibleActions.length, {}, language)
              : [
                  deleteFileCount(plan)
                    ? tCount("operations.restore.filesRemoved", deleteFileCount(plan), {}, language)
                    : "",
                  providerSettings
                    ? settingsWriteCount
                      ? tCount(
                          harnessSetting
                            ? "operations.restore.settingsRestored"
                            : "operations.restore.settingsEntriesRemoved",
                          settingsWriteCount,
                          {},
                          language,
                        )
                      : ""
                    : manifestCount(plan)
                      ? tCount("operations.restore.manifestsRestored", manifestCount(plan), {}, language)
                      : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
          }
        />
      </ItemList>
      <div className="import-file-list" data-testid="restore-file-list">
        {visibleActions.map((action) => (
          <div className="import-file-list__row" key={`${action.kind}:${action.relativePath}`}>
            <code>{relativePath(action.relativePath, plan.displayTarget)}</code>
            <span>{actionLabel(action, t, providerSettings, harnessSetting)}</span>
          </div>
        ))}
      </div>
      {plan.kind === "restore-add-to-project" ? (
        <p data-testid="restore-children-note">{t("operations.restore.childrenReverse")}</p>
      ) : null}
      {plan.git.mode === "disabled" || (plan.git.mode === "not-a-repository" && !plan.git.warnings[0]) ? null : (
        <ItemList variant="nested">
          <ListItem
            name={t("operations.preview.git")}
            sub={
              plan.git.warnings[0] ??
              (plan.kind === "restore-add-to-project"
                ? t("operations.restore.addToProjectGit", compositeParts(plan.displayTarget))
                : lifecycle
                  ? t("operations.lifecycle.restoreGitCommit", { project: plan.displayTarget })
                  : t("operations.preview.gitCommit", { target: packageName(plan.displayTarget) }))
            }
          />
        </ItemList>
      )}
    </Card>
  );
}

export function RestoreWorkbench({
  api,
  operationId,
  onMarketplaceChanged,
  onNavigateToRoute,
  onApplyingChange,
  onProjectChanged,
}: RestoreWorkbenchProps): ReactElement {
  const { language, t } = useI18n();
  const [receipt, setReceipt] = useState<OperationReceipt | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [result, setResult] = useState<OperationReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onApplyingChange?.(busy);
    return () => onApplyingChange?.(false);
  }, [busy, onApplyingChange]);

  useEffect(() => {
    let active = true;
    if (!api?.listOperations)
      return () => {
        active = false;
      };
    void api
      .listOperations()
      .then((response) => {
        if (!active || response.status !== "ready") return;
        const original = response.receipts.find((candidate) => candidate.operationId === operationId) ?? null;
        setReceipt(original);
        if (!original) return;
        const previewRequest =
          original.kind === "apply-plan" || original.kind === "remove-binding"
            ? api.previewRestoreApply?.({ operationId })
            : api.previewOperation?.({ kind: "restore-import", operationId });
        if (!previewRequest) {
          setError(t("projectView.operationUnavailable"));
          return;
        }
        setBusy(true);
        return previewRequest
          .then((previewResponse) => {
            if (!active) return;
            if (original.kind === "apply-plan" || original.kind === "remove-binding") {
              const lifecyclePreview = previewResponse as RestorePreviewResponse | ApplyBlockedResponse;
              setPreview(
                lifecyclePreview.status === "ready"
                  ? {
                      kind: "ready",
                      plan: {
                        planId: lifecyclePreview.planId,
                        kind: original.kind === "remove-binding" ? "remove-binding" : "restore-apply",
                        displayTarget: original.displayTarget,
                        actions: lifecyclePreview.files.map((file) => ({
                          kind: file.action === "restore" ? "write-file" : "delete-file",
                          relativePath: file.relativePath,
                        })),
                        git: { mode: "commit", warnings: [] },
                      },
                    }
                  : {
                      kind: "blocked",
                      reason: lifecyclePreview.reason,
                      diagnostic: lifecyclePreview.diagnostic ?? lifecyclePreview.reason,
                    },
              );
            } else {
              const legacy = previewResponse as PreviewMarketplaceResponse;
              setPreview(
                legacy.status === "ready"
                  ? { kind: "ready", plan: legacy.plan }
                  : { kind: "blocked", reason: legacy.reason, diagnostic: legacy.diagnostic },
              );
            }
          })
          .catch(() => {
            if (active) setError(t("operations.unavailable"));
          })
          .finally(() => {
            if (active) setBusy(false);
          });
      })
      .catch(() => {
        if (active) setError(t("operations.unavailable"));
      });
    return () => {
      active = false;
    };
  }, [api, operationId, t]);

  const apply = async (): Promise<void> => {
    if (preview?.kind !== "ready") return;
    setBusy(true);
    try {
      const response =
        receipt?.kind === "apply-plan" || receipt?.kind === "remove-binding"
          ? await api?.runRestoreApply?.({ planId: preview.plan.planId })
          : await api?.applyOperation?.({ planId: preview.plan.planId });
      if (!response) return;
      if (response.status === "blocked") {
        setError(`${response.reason}${response.diagnostic ? `: ${response.diagnostic}` : ""}`);
        return;
      }
      setResult(response.receipt);
      setPreview(null);
      if (response.status === "applied") {
        if (receipt?.project) onProjectChanged?.(receipt.project.id);
        else onMarketplaceChanged?.();
      } else setError(t("operations.failedReceipt", { status: response.receipt.status }));
    } catch {
      setError(t("operations.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  const target = receipt?.displayTarget ?? operationId;
  const lifecycle =
    receipt?.kind === "apply-plan" || receipt?.kind === "remove-binding" || receipt?.kind === "make-compatible";
  const skillName =
    receipt?.kind === "write-skill" ? receipt.files?.[0]?.relativePath.match(/skills\/([^/]+)\//u)?.[1] : undefined;
  const artifactName = skillName ?? (lifecycle ? target : artifactLabel(receipt?.source?.relativePath ?? operationId));
  const units = receipt?.units?.join(", ") ?? artifactName;
  const captureDate = receipt
    ? new Date(receipt.appliedAt).toLocaleDateString(language === "fr" ? "fr-FR" : "en-US")
    : "—";
  const description =
    receipt?.kind === "link-storefront"
      ? preview?.kind === "ready"
        ? preview.plan.notes?.join(" ")
        : undefined
      : receipt?.kind === "register-project"
        ? t("agents.projectRegistrationEffect")
        : receipt
          ? receipt.kind === "install-agents"
            ? t("agentsSetup.restoreDescription")
            : receipt.kind === "register-mcp"
              ? t("operations.restore.registerMcpDescription", {
                  harness:
                    receipt.harness === "codex" ? t("operations.harness.codex") : t("operations.harness.claudeCode"),
                  date: captureDate,
                })
              : receipt.kind === "write-harness-setting"
                ? t("operations.restore.harnessSettingDescription", { date: captureDate })
                : receipt.kind === "apply-plan"
                  ? t("operations.restore.applyDescription", { project: target, date: captureDate, units })
                  : receipt.kind === "remove-binding"
                    ? t("operations.restore.removeDescription", { units, date: captureDate })
                    : receipt.kind === "make-compatible"
                      ? t("operations.restore.compatibleDescription", {
                          marketplace: target,
                          date: captureDate,
                          harness:
                            receipt.harness === "codex"
                              ? t("operations.harness.codex")
                              : t("operations.harness.claudeCode"),
                        })
                      : receipt.kind === "write-skill"
                        ? t("operations.restore.skillDescription", { date: captureDate })
                        : receipt.kind === "add-to-project"
                          ? t("operations.restore.addToProjectDescription", {
                              ...compositeParts(target),
                              date: captureDate,
                            })
                          : t("operations.restore.description", { date: captureDate, package: packageName(target) })
          : undefined;
  const heading =
    receipt?.kind === "link-storefront"
      ? `${t("projectView.undo")} ${target}`
      : receipt?.kind === "register-project"
        ? t("agents.archiveProject", { name: target })
        : receipt?.kind === "install-agents"
          ? t("agentsSetup.restoreHeading")
          : receipt?.kind === "register-mcp"
            ? t("operations.restore.registerMcpHeading", {
                harness:
                  receipt.harness === "codex" ? t("operations.harness.codex") : t("operations.harness.claudeCode"),
              })
            : receipt?.kind === "write-harness-setting"
              ? t("operations.restore.harnessSettingHeading")
              : t("operations.restore.heading", { name: artifactName });
  const applied = result?.status === "applied";
  return (
    <WorkflowWorkbench
      title={heading}
      subtitle={description}
      busy={busy}
      hasResult={Boolean(result)}
      onClose={() => onNavigateToRoute({ screen: "review" })}
      receipt={result}
      onNavigate={onNavigateToRoute}
      footer={
        !result ? (
          <>
            {preview?.kind === "blocked" ? (
              <WorkflowFooter note={`${preview.reason}: ${preview.diagnostic}`} />
            ) : preview?.kind === "ready" ? (
              <WorkflowFooter
                actions={
                  <Button dataTestId="restore-apply" disabled={busy} onClick={() => void apply()}>
                    {receipt?.kind === "register-project"
                      ? t("agents.archiveProject", { name: receipt.displayTarget })
                      : t("operations.restore.apply")}
                  </Button>
                }
                note={t("operations.confirmNote")}
              />
            ) : null}
          </>
        ) : null
      }
      api={api}
    >
      <div data-testid="restore-import-page">
        {!applied ? (
          <>
            {!result && preview?.kind === "ready" && receipt ? (
              <RestorePreview language={language} plan={preview.plan} t={t} />
            ) : null}
            {!result && receipt && preview === null ? (
              <Card>
                <CardHeader title={t("operations.restore.preview")} />
                <ItemList variant="nested">
                  <LoadingSkeleton label={t("operations.restore.loading")} />
                </ItemList>
              </Card>
            ) : null}
            {error ? (
              <Callout title={t("operations.failed")} tone="error">
                {error}
              </Callout>
            ) : null}
          </>
        ) : null}
        {applied ? (
          <>
            <div data-testid="restore-result">
              <Card>
                <CardHeader
                  title={t("operations.restore.result")}
                  count={
                    result.git.commit ? (
                      <Badge variant="count">{result.git.commit.slice(0, 7)}</Badge>
                    ) : (
                      <Badge tone="ok" variant="status">
                        {t("operations.applied")}
                      </Badge>
                    )
                  }
                />
                <ItemList variant="nested">
                  <ListItem name={t("operations.restore.result")} />
                </ItemList>
              </Card>
            </div>
            <div data-testid="restore-result-footer">
              <WorkflowFooter
                actions={
                  <Button dataTestId="restore-back" onClick={() => onNavigateToRoute({ screen: "review" })}>
                    {t("operations.backToReview")}
                  </Button>
                }
              />
            </div>
          </>
        ) : null}
      </div>
    </WorkflowWorkbench>
  );
}
