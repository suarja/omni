import { useEffect, useRef, useState } from "react";
import type { OperationPlan, OperationReceipt } from "../../shared/operations-ipc";
import type { WriteSkillRequest } from "../../shared/operations-write-skill-ipc";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { useI18n } from "../i18n";

type Target = Readonly<{ id: string; name: string }>;
export function useNewSkillCreation(
  options: Readonly<{
    canvas: ResourceCanvasProps;
    request: WriteSkillRequest | null;
    targets: readonly Target[];
    pluginName: string;
    onApplyingChange: (busy: boolean) => void;
  }>,
): Readonly<{
  plan: OperationPlan | null;
  busy: boolean;
  previewing: boolean;
  created: boolean;
  error: string | null;
  complete: string | null;
  apply: () => Promise<void>;
  undo: () => Promise<void>;
}> {
  const { t } = useI18n();
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState<string | null>(null);
  const source = useRef<OperationReceipt | null>(null);
  const createdRequest = useRef<WriteSkillRequest | null>(null);
  const createdTargets = useRef<readonly Target[] | null>(null);
  const createdPlugin = useRef<string | null>(null);
  const assignments = useRef<string[]>([]);
  const installed = useRef(new Set<string>());
  const locked = useRef(false);
  const api = options.canvas.api;
  useEffect(() => {
    let current = true;
    setPlan(null);
    if (source.current || !options.request) {
      setPreviewing(false);
      return;
    }
    setError(null);
    setPreviewing(true);
    void (async () => {
      if (!api?.previewOperation) throw new Error(t("projectView.operationUnavailable"));
      const result = await api.previewOperation(options.request!);
      if (!current) return;
      if (result.plan) setPlan(result.plan);
      if (result.status !== "ready") setError(result.diagnostic);
    })()
      .catch((error: unknown) => {
        if (current) setError(error instanceof Error ? error.message : t("projectView.operationFailed"));
      })
      .finally(() => {
        if (current) setPreviewing(false);
      });
    return () => {
      current = false;
    };
  }, [options.request, api, t]);
  async function installTargets(
    request: WriteSkillRequest,
    packageId: string,
    targets: readonly Target[],
  ): Promise<void> {
    for (const target of targets) {
      if (installed.current.has(target.id)) continue;
      if (!api?.previewSkillOperation || !api.applySkillOperation)
        throw new Error(t("projectView.operationUnavailable"));
      if (!(await options.canvas.onEnsureGrant({ kind: "project", id: target.id })))
        throw new Error(t("projectView.operationUnavailable"));
      const preview = await api.previewSkillOperation({
        intent: {
          kind: "assign",
          sourceId: request.sourceId,
          packageId,
          artifactPath: `skills/${request.folderName}`,
          targets: [{ projectId: target.id, harnessIds: ["claude-code", "codex"] }],
        },
      });
      if (preview.status !== "ready") throw new Error(preview.reason);
      const result = await api.applySkillOperation({
        intentId: preview.intentId,
        effectFingerprint: preview.effectFingerprint,
      });
      if (result.operationId && result.receiptIds.length) assignments.current.push(result.operationId);
      if (result.status !== "applied" && result.status !== "no-op")
        throw new Error(result.issues.map((issue) => issue.message).join("\n") || t("projectView.partial"));
      installed.current.add(target.id);
    }
  }
  async function apply(): Promise<void> {
    const request = createdRequest.current ?? options.request;
    const targets = createdTargets.current ?? options.targets;
    const plugin = createdPlugin.current ?? options.pluginName;
    if (locked.current || !request || (!source.current && (!plan || error || previewing)) || !api?.applyOperation)
      return;
    locked.current = true;
    setBusy(true);
    setError(null);
    options.onApplyingChange(true);
    const packageId = request.packageId ?? `packages/${request.newPackage!.name}`;
    try {
      if (!source.current) {
        const result = await api.applyOperation({ planId: plan!.planId });
        if (result.status !== "applied") throw new Error(result.receipt.diagnostic ?? t("projectView.partial"));
        source.current = result.receipt;
        createdRequest.current = request;
        createdTargets.current = targets;
        createdPlugin.current = plugin;
        setCreated(true);
      }
      await installTargets(request, packageId, targets);
      options.canvas.onRefresh();
      setComplete(
        t(targets.length ? "newSkill.installed" : "newSkill.created", {
          name: request.folderName,
          plugin,
          projects: targets.map((target) => target.name).join(", "),
        }),
      );
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : t("projectView.operationFailed");
      setError(
        source.current ? `${t("newSkill.partial", { name: request.folderName, plugin })} ${diagnostic}` : diagnostic,
      );
      if (source.current) options.canvas.onRefresh();
    } finally {
      locked.current = false;
      setBusy(false);
      options.onApplyingChange(false);
    }
  }
  async function undo(): Promise<void> {
    if (locked.current || !source.current || !api?.previewOperation || !api.applyOperation) return;
    locked.current = true;
    options.onApplyingChange(true);
    try {
      for (const operationId of [...assignments.current].reverse()) {
        if (!api.previewSkillOperation || !api.applySkillOperation)
          throw new Error(t("projectView.operationUnavailable"));
        const preview = await api.previewSkillOperation({ intent: { kind: "restore", operationId } });
        if (preview.status !== "ready") throw new Error(preview.reason);
        const result = await api.applySkillOperation({
          intentId: preview.intentId,
          effectFingerprint: preview.effectFingerprint,
        });
        if (result.status !== "restored" && result.status !== "no-op")
          throw new Error(result.issues.map((issue) => issue.message).join("\n") || t("projectView.partial"));
        assignments.current.pop();
      }
      const preview = await api.previewOperation({ kind: "restore-import", operationId: source.current.operationId });
      if (preview.status !== "ready") throw new Error(preview.diagnostic);
      const result = await api.applyOperation({ planId: preview.plan.planId });
      if (result.status !== "applied") throw new Error(result.receipt.diagnostic ?? t("projectView.partial"));
      options.canvas.onRefresh();
    } finally {
      locked.current = false;
      options.onApplyingChange(false);
    }
  }
  return { plan, busy, previewing, created, error, complete, apply, undo };
}
