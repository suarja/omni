import { useRef, useState } from "react";
import type { ProjectSkillHarness, ProjectSkillRow } from "../../shared/project-skills-ipc";
import type { SkillIntent, SkillPreview, SkillResult } from "../../shared/skill-management-ipc";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { useI18n } from "../i18n";
import { harnessLabel, projectSkillIntent } from "./project-view-model";

export type ProjectConfirmation = Readonly<{
  row: ProjectSkillRow;
  action: "disable" | "enable" | "delete" | "remove-agent";
  harness?: ProjectSkillHarness;
  projectId: string;
  projectName: string;
  preview: SkillPreview | null;
  anchor: HTMLElement | null;
}>;
export type ProjectToast = Readonly<{ message: string; operationIds: readonly string[] }>;
type ProjectOperations = Readonly<{
  confirmation: ProjectConfirmation | null;
  busy: boolean;
  error: string | null;
  toast: ProjectToast | null;
  prepare: (
    row: ProjectSkillRow,
    action: ProjectConfirmation["action"],
    harness?: ProjectSkillHarness,
    target?: Readonly<{ id: string; name: string }>,
  ) => Promise<void>;
  confirm: () => Promise<void>;
  cancel: () => void;
  toggleAgent: (
    row: ProjectSkillRow,
    harness: ProjectSkillHarness,
    target?: Readonly<{ id: string; name: string }>,
  ) => Promise<void>;
  recordOperations: (operationIds: readonly string[], message: string) => void;
  runIntents: (intents: readonly SkillIntent[], message: string) => Promise<void>;
  undo: () => Promise<void>;
  recordResult: (result: SkillResult, message: string) => void;
}>;
export function useProjectOperations(
  input: Readonly<{
    api: ResourceCanvasProps["api"];
    projectId: string;
    projectName: string;
    onChanged: () => Promise<void>;
    onEnsureGrant: ResourceCanvasProps["onEnsureGrant"];
  }>,
): ProjectOperations {
  const { t } = useI18n();
  const [confirmation, setConfirmation] = useState<ProjectConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ProjectToast | null>(null);
  const locked = useRef(false);
  const reviewRevision = useRef(0);
  const opener = useRef<HTMLElement | null>(null);

  function focusOpener(): void {
    requestAnimationFrame(() => opener.current?.isConnected && opener.current.focus());
  }
  async function finish(): Promise<void> {
    try {
      await input.onChanged();
    } catch {
      setError(t("projectView.unavailable"));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  function recordResult(result: SkillResult, message: string): void {
    const partial = !["applied", "restored", "no-op"].includes(result.status);
    setToast({
      message: partial ? t("projectView.partial") : message,
      operationIds: result.status === "applied" || result.receiptIds.length ? [result.operationId] : [],
    });
    setError(
      partial
        ? [
            t("projectView.partial"),
            ...result.issues.map((issue) => `${issue.relativePath ?? issue.projectId ?? ""} · ${issue.message}`),
          ].join("\n")
        : null,
    );
  }
  async function previewIntent(intent: SkillIntent): Promise<SkillPreview> {
    if (!input.api?.previewSkillOperation) throw new Error(t("projectView.operationUnavailable"));
    if (intent.kind === "assign" && !(await input.onEnsureGrant({ kind: "source", id: intent.sourceId })))
      throw new Error(t("projectView.operationUnavailable"));
    return input.api.previewSkillOperation({ intent });
  }
  async function applyPreview(preview: SkillPreview): Promise<SkillResult> {
    if (preview.status !== "ready")
      throw new Error(
        [preview.reason, ...preview.details.map((detail) => `${detail.relativePath ?? ""} · ${detail.message}`)].join(
          "\n",
        ),
      );
    if (!input.api?.applySkillOperation) throw new Error(t("projectView.operationUnavailable"));
    return input.api.applySkillOperation({ intentId: preview.intentId, effectFingerprint: preview.effectFingerprint });
  }
  async function runIntents(intents: readonly SkillIntent[], message: string): Promise<void> {
    if (locked.current || confirmation) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    const operationIds: string[] = [];
    try {
      for (const intent of intents) {
        const result = await applyPreview(await previewIntent(intent));
        if (result.status === "applied" || result.receiptIds.length) operationIds.push(result.operationId);
        recordResult(result, message);
        if (!["applied", "restored", "no-op"].includes(result.status)) {
          setToast({ message: t("projectView.partial"), operationIds });
          return;
        }
      }
      setToast({ message, operationIds });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("projectView.operationFailed"));
      if (operationIds.length) setToast({ message: t("projectView.partial"), operationIds });
    } finally {
      await finish();
    }
  }
  async function prepare(
    row: ProjectSkillRow,
    action: ProjectConfirmation["action"],
    harness?: ProjectSkillHarness,
    target: Readonly<{ id: string; name: string }> = { id: input.projectId, name: input.projectName },
  ): Promise<void> {
    if (locked.current || confirmation) return;
    const revision = ++reviewRevision.current;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rowElement = [...document.querySelectorAll<HTMLElement>("[data-skill-row-id]")].find(
      (element) => element.dataset.skillRowId === row.id,
    );
    opener.current = active?.closest(".canvas-menu")
      ? (rowElement?.querySelector<HTMLElement>(".project-more") ?? active)
      : active;
    locked.current = true;
    setBusy(true);
    setError(null);
    setConfirmation({
      row,
      action,
      harness,
      projectId: target.id,
      projectName: target.name,
      preview: null,
      anchor: opener.current,
    });
    try {
      const preview = await previewIntent(projectSkillIntent(target.id, row, action, harness));
      if (revision === reviewRevision.current)
        setConfirmation({
          row,
          action,
          harness,
          projectId: target.id,
          projectName: target.name,
          preview,
          anchor: opener.current,
        });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("projectView.operationFailed"));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function cancel(): void {
    if (locked.current) return;
    reviewRevision.current += 1;
    setConfirmation(null);
    setError(null);
    focusOpener();
  }
  async function confirm(): Promise<void> {
    if (locked.current || !confirmation?.preview || confirmation.preview.status !== "ready") return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await applyPreview(confirmation.preview);
      const last =
        confirmation.action === "remove-agent" &&
        Object.values(confirmation.row.agents).filter((agent) => agent.state === "installed").length === 1;
      recordResult(
        result,
        confirmation.action === "remove-agent"
          ? t(last ? "skillActions.disabledToast" : "skillActions.removedToast", {
              name: confirmation.row.name,
              project: confirmation.projectName,
              agent: harnessLabel(confirmation.harness!),
            })
          : t("projectView.changed", {
              name: confirmation.row.name,
              project: confirmation.projectName,
              action: t(`projectView.${confirmation.action === "delete" ? "deleteAction" : confirmation.action}`),
            }),
      );
      setConfirmation(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("projectView.operationFailed"));
    } finally {
      await finish();
      focusOpener();
    }
  }
  async function toggleAgent(
    row: ProjectSkillRow,
    harness: ProjectSkillHarness,
    target: Readonly<{ id: string; name: string }> = { id: input.projectId, name: input.projectName },
  ): Promise<void> {
    if (row.agents[harness].state === "installed") await prepare(row, "remove-agent", harness, target);
    else
      await runIntents(
        [projectSkillIntent(target.id, row, "install-agent", harness)],
        t("skillActions.installedToast", { name: row.name, agent: harnessLabel(harness), project: target.name }),
      );
  }
  function recordOperations(operationIds: readonly string[], message: string): void {
    setToast({ message, operationIds });
  }
  async function undo(): Promise<void> {
    if (locked.current || confirmation || !toast?.operationIds.length) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    const remaining = [...toast.operationIds];
    try {
      while (remaining.length) {
        const operationId = remaining.at(-1)!;
        const result = await applyPreview(await previewIntent({ kind: "restore", operationId }));
        if (!["applied", "restored", "no-op"].includes(result.status)) {
          recordResult(result, t("projectView.undone"));
          setToast({ message: t("projectView.partial"), operationIds: remaining });
          return;
        }
        remaining.pop();
      }
      setToast({ message: t("projectView.undone"), operationIds: [] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("projectView.operationFailed"));
      setToast({ message: t("projectView.partial"), operationIds: remaining });
    } finally {
      await finish();
    }
  }
  return {
    confirmation,
    busy,
    error,
    toast,
    prepare,
    confirm,
    cancel,
    toggleAgent,
    runIntents,
    undo,
    recordResult,
    recordOperations,
  };
}
