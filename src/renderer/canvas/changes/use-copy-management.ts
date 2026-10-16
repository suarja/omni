import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ResourceSnapshot } from "../../../domain/resource-catalogue";
import type { EntryRef, Observation } from "../../../domain/project-source-registry";
import type { ManagedSkillUse, SkillLocationKey, SourceSkillRef } from "../../../domain/skill-reconciliation/types";
import type { DesktopApi } from "../../../shared/ipc";
import type { SkillIntent, SkillResult } from "../../../shared/skill-management-ipc";
import type { LogicalSkillNode } from "../spatial/spatial-types";
import { skillVariantDestinations } from "../skill-variant-destinations";
import { useOwnedSkillChoices } from "../use-owned-skill-choices";
import { useSkillOperation } from "./use-skill-operation";
import { useSkillCopyComparison, type SkillCopyComparisonPair } from "./use-skill-copy-comparison";
import {
  availableCopyManagementActions,
  buildCopyManagementReview,
  type CopyManagementAction,
} from "./copy-management-actions";
import { copyLocationKey, safeVariantKey } from "./copy-management-view-model";
import { canReviewRestore } from "./operation-view-model";

type CopyManagementApi = Pick<
  DesktopApi,
  | "compareSkillCopies"
  | "previewSkillOperation"
  | "refreshSkillOperation"
  | "applySkillOperation"
  | "readSkillOperationResult"
> &
  Partial<Pick<DesktopApi, "onReviewChanged">>;
export type CopyManagementStage = "compare" | "effects" | "result";

function firstReference(
  locations: readonly SkillLocationKey[],
  target: SkillLocationKey,
): SkillLocationKey | undefined {
  return locations.find((location) => copyLocationKey(location) !== copyLocationKey(target));
}

function sameIntent(left: SkillIntent | null, right: SkillIntent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function useCopyManagement(
  input: Readonly<{
    api: CopyManagementApi | null;
    snapshot: ResourceSnapshot;
    node: LogicalSkillNode;
    managedUses: readonly ManagedSkillUse[];
    managedUsesStatus: "ready" | "loading" | "unavailable";
    initialTarget: SkillLocationKey;
    workflowKey: string;
    onEnsureGrant: (entry: EntryRef) => Promise<string | null>;
    onObserveSource?: (sourceId: string, isCurrent: () => boolean) => Promise<Observation | null>;
    onRefresh: () => void | Promise<void>;
    initialResult?: SkillResult;
    initialRestoreReview?: boolean;
  }>,
): Readonly<{
  action: CopyManagementAction | "";
  actions: readonly CopyManagementAction[];
  target: SkillLocationKey;
  reference?: SkillLocationKey;
  comparison: ReturnType<typeof useSkillCopyComparison>;
  decision: ReturnType<typeof buildCopyManagementReview>;
  policyError: string | null;
  sourceChoices: ReturnType<typeof useOwnedSkillChoices>;
  destinations: ReturnType<typeof skillVariantDestinations>;
  destinationValue: string;
  destination?: Readonly<{ sourceId: string; packageId: string }>;
  destinationLabel?: string;
  skillKey: string;
  stage: CopyManagementStage;
  restoreReview: boolean;
  localNoWrite: boolean;
  localNoWriteResult: boolean;
  result: SkillResult | null;
  operation: ReturnType<typeof useSkillOperation>;
  previewSignature: string | null;
  reviewCurrent: boolean;
  setAction(action: CopyManagementAction): void;
  selectTarget(location: SkillLocationKey): void;
  selectReference(location: SkillLocationKey): void;
  selectSource(value: string): void;
  retrySource(): void;
  selectDestination(value: string): void;
  setSkillKey(value: string): void;
  reviewEffects(): void;
  refreshPreview(): Promise<void>;
  apply(): Promise<SkillResult | null>;
  reviewRestore(): void;
  cancelRestore(): void;
  finishLocalKeep(): void;
  backToCompare(): void;
  showResult(): void;
  refreshObservation(): Promise<void>;
}> {
  const locations = input.node.locations.map(({ location }) => location);
  const [target, setTarget] = useState(input.initialTarget);
  const [reference, setReference] = useState(() => firstReference(locations, input.initialTarget));
  const [action, setActionState] = useState<CopyManagementAction | "">("");
  const [stage, setStage] = useState<CopyManagementStage>(
    input.initialRestoreReview ? "effects" : input.initialResult ? "result" : "compare",
  );
  const [destinationValue, setDestinationValue] = useState("");
  const [skillKey, setSkillKeyState] = useState("");
  const [restoreReview, setRestoreReview] = useState(input.initialRestoreReview ?? false);
  const [localNoWrite, setLocalNoWrite] = useState(false);
  const [localNoWriteResult, setLocalNoWriteResult] = useState(false);
  const [savedResult, setSavedResult] = useState<SkillResult | null>(
    input.initialRestoreReview ? null : (input.initialResult ?? null),
  );
  const [preservedResult, setPreservedResult] = useState<SkillResult | null>(
    input.initialRestoreReview ? (input.initialResult ?? null) : null,
  );
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [previewSignature, setPreviewSignature] = useState<string | null>(null);
  const restoreStart = useRef(false);
  const operation = useSkillOperation(input.api, input.workflowKey);
  const sourceChoices = useOwnedSkillChoices(
    input.snapshot,
    input.onObserveSource,
    JSON.stringify([input.workflowKey, target]),
  );
  const comparisonPair: SkillCopyComparisonPair | undefined = reference ? { a: reference, b: target } : undefined;
  const comparison = useSkillCopyComparison({
    api: input.api,
    projectId: target.projectId,
    skillId: input.node.skillId,
    locations,
    initialLeft: input.initialTarget,
    ...(comparisonPair ? { initialPair: comparisonPair } : {}),
    onEnsureGrant: input.onEnsureGrant,
  });
  const destinations = useMemo(() => skillVariantDestinations(input.snapshot), [input.snapshot]);
  const destination = destinationValue
    ? destinations.find(({ sourceId, packageId }) => `${sourceId}:${packageId}` === destinationValue)
    : undefined;
  const locationUse = input.managedUses.find((use) => copyLocationKey(use.location) === copyLocationKey(target));
  const binding =
    locationUse && input.snapshot.uses.status === "ready"
      ? input.snapshot.uses.bindings.find((candidate) => candidate.bindingId === locationUse.bindingId)
      : undefined;
  const member = input.node.members.find(
    (candidate) => copyLocationKey(candidate.location) === copyLocationKey(target),
  );
  const readable = member?.read.status === "complete";
  const usesStatus =
    input.managedUsesStatus === "ready" && input.snapshot.uses.status === "ready"
      ? "ready"
      : input.managedUsesStatus === "unavailable" || input.snapshot.uses.status === "unavailable"
        ? "unavailable"
        : "loading";
  const sourceEvidenceKey = sourceChoices.sourceObservationKey ?? null;
  const destinationRoot = destination
    ? input.snapshot.roots.find((root) => root.entry.kind === "source" && root.entry.id === destination.sourceId)
    : undefined;
  const destinationEvidenceKey =
    destinationRoot?.evidence.status === "observed"
      ? destinationRoot.evidence.observation.observedAt
      : (destinationRoot?.evidence.status ?? null);
  const source: SourceSkillRef | undefined = sourceChoices.selected?.source;
  const reviewInput = {
    action,
    skillId: input.node.skillId,
    location: target,
    readable: Boolean(readable),
    usesStatus,
    ...(locationUse ? { locationUse } : {}),
    ...(binding ? { binding } : {}),
    ...(source ? { source } : {}),
    ...(destination ? { destination: { sourceId: destination.sourceId, packageId: destination.packageId } } : {}),
    ...(skillKey ? { skillKey } : {}),
  } as const;
  const decision = buildCopyManagementReview(reviewInput);
  const actions = availableCopyManagementActions({
    skillId: input.node.skillId,
    location: target,
    readable: Boolean(readable),
    usesStatus,
    ...(locationUse ? { locationUse } : {}),
    ...(binding ? { binding } : {}),
  });
  const currentSignature = JSON.stringify([
    input.workflowKey,
    target,
    reference ?? null,
    member?.read.status === "complete"
      ? [member.read.revision.algorithm, member.read.revision.hash]
      : (member?.read.status ?? "missing"),
    usesStatus,
    locationUse ?? null,
    binding ?? null,
    action,
    source ?? null,
    sourceEvidenceKey,
    destinationValue,
    destinationEvidenceKey,
    skillKey,
  ]);
  const result = preservedResult ?? savedResult ?? operation.result;
  const reviewCurrent = previewSignature === currentSignature;

  useEffect(() => {
    if (!input.initialRestoreReview || !input.initialResult || restoreStart.current) return;
    restoreStart.current = true;
    setPreviewSignature(currentSignature);
    void operation.inspect({ kind: "restore", operationId: input.initialResult.operationId });
  }, [currentSignature, input.initialRestoreReview, input.initialResult, operation.inspect]);

  const invalidate = useCallback((): void => {
    operation.clearReview();
    setPreviewSignature(null);
    setPolicyError(null);
    setLocalNoWrite(false);
  }, [operation.clearReview]);
  const setAction = useCallback(
    (next: CopyManagementAction): void => {
      if (next === action) return;
      invalidate();
      setActionState(next);
      setStage("compare");
    },
    [action, invalidate],
  );
  const selectTarget = useCallback(
    (next: SkillLocationKey): void => {
      if (!locations.some((location) => copyLocationKey(location) === copyLocationKey(next))) return;
      if (copyLocationKey(next) === copyLocationKey(target)) return;
      const nextReference =
        reference && copyLocationKey(reference) !== copyLocationKey(next) ? reference : firstReference(locations, next);
      setActionState("");
      setTarget(next);
      setReference(nextReference);
      sourceChoices.reset();
      if (nextReference) comparison.selectPair({ a: nextReference, b: next });
      invalidate();
      setStage("compare");
    },
    [comparison.selectPair, invalidate, locations, reference, sourceChoices.reset, target],
  );
  const selectReference = useCallback(
    (next: SkillLocationKey): void => {
      if (
        copyLocationKey(next) === copyLocationKey(target) ||
        !locations.some((location) => copyLocationKey(location) === copyLocationKey(next))
      )
        return;
      setReference(next);
      comparison.selectPair({ a: next, b: target });
      invalidate();
      setStage("compare");
    },
    [comparison.selectPair, invalidate, locations, target],
  );
  const selectSource = useCallback(
    (value: string): void => {
      invalidate();
      sourceChoices.selectChoice(value);
    },
    [invalidate, sourceChoices.selectChoice],
  );
  const retrySource = useCallback((): void => {
    invalidate();
    sourceChoices.retrySource();
  }, [invalidate, sourceChoices.retrySource]);
  const selectDestination = useCallback(
    (value: string): void => {
      invalidate();
      setDestinationValue(value);
      const found = destinations.find(({ sourceId, packageId }) => `${sourceId}:${packageId}` === value);
      if (!found) {
        setSkillKeyState("");
        return;
      }
      const projectName =
        input.snapshot.registry.projects.find((project) => project.ref.id === target.projectId)?.displayName ??
        target.projectId;
      setSkillKeyState(safeVariantKey(input.snapshot, found.sourceId, found.packageId, input.node.label, projectName));
    },
    [destinations, input.node.label, input.snapshot, invalidate, target.projectId],
  );
  const setSkillKey = useCallback(
    (value: string): void => {
      invalidate();
      setSkillKeyState(value);
    },
    [invalidate],
  );
  const reviewEffects = useCallback((): void => {
    setPolicyError(null);
    if (decision.kind === "unavailable") {
      setPolicyError(decision.reason);
      return;
    }
    if (decision.kind === "local-no-write") {
      setPreviewSignature(currentSignature);
      setLocalNoWrite(true);
      setStage("effects");
      return;
    }
    setLocalNoWrite(false);
    setPreviewSignature(currentSignature);
    setRestoreReview(false);
    setStage("effects");
    void operation.inspect(decision.intent);
  }, [currentSignature, decision, operation.inspect]);
  const refreshPreview = useCallback(async (): Promise<void> => {
    const refreshed = await operation.refresh();
    if (refreshed) setPreviewSignature(currentSignature);
  }, [currentSignature, operation.refresh]);
  const apply = useCallback(async (): Promise<SkillResult | null> => {
    if (stage !== "effects") return null;
    if (localNoWrite) {
      if (decision.kind !== "local-no-write" || previewSignature !== currentSignature) return null;
      setLocalNoWriteResult(true);
      setSavedResult(null);
      setStage("result");
      return null;
    }
    const currentIntent: SkillIntent = restoreReview
      ? { kind: "restore", operationId: preservedResult?.operationId ?? "" }
      : decision.kind === "operation"
        ? decision.intent
        : { kind: "restore", operationId: "" };
    if (
      operation.preview?.status !== "ready" ||
      previewSignature !== currentSignature ||
      !sameIntent(operation.intent, currentIntent)
    )
      return null;
    const applied = await operation.apply();
    if (!applied) return null;
    setSavedResult(applied);
    setPreservedResult(null);
    setLocalNoWriteResult(false);
    setRestoreReview(false);
    setStage("result");
    if (applied.status !== "no-op" && applied.status !== "cancelled") await input.onRefresh();
    return applied;
  }, [
    currentSignature,
    decision,
    input.onRefresh,
    localNoWrite,
    operation.apply,
    operation.intent,
    operation.preview,
    preservedResult?.operationId,
    previewSignature,
    restoreReview,
    stage,
  ]);
  const reviewRestore = useCallback((): void => {
    if (!result || result.status === "restored" || !canReviewRestore(result)) return;
    setPreservedResult(result);
    setSavedResult(null);
    setLocalNoWriteResult(false);
    setRestoreReview(true);
    setPreviewSignature(currentSignature);
    setStage("effects");
    void operation.inspect({ kind: "restore", operationId: result.operationId });
  }, [currentSignature, operation.inspect, result]);
  const cancelRestore = useCallback((): void => {
    if (!restoreReview) return;
    operation.clearReview();
    setSavedResult(preservedResult);
    setPreservedResult(null);
    setRestoreReview(false);
    setPreviewSignature(null);
    setStage("result");
  }, [operation.clearReview, preservedResult, restoreReview]);
  const finishLocalKeep = useCallback((): void => {
    if (localNoWrite && decision.kind === "local-no-write" && previewSignature === currentSignature) {
      setLocalNoWrite(false);
      setLocalNoWriteResult(true);
      setStage("result");
    }
  }, [currentSignature, decision, localNoWrite, previewSignature]);
  const backToCompare = useCallback((): void => {
    invalidate();
    setRestoreReview(false);
    setStage("compare");
  }, [invalidate]);
  const showResult = useCallback((): void => {
    if (!result) return;
    operation.clearReview();
    setPreviewSignature(null);
    setLocalNoWrite(false);
    setStage("result");
  }, [operation.clearReview, result]);
  const refreshObservation = useCallback(async (): Promise<void> => {
    comparison.refresh();
    await input.onRefresh();
  }, [comparison.refresh, input.onRefresh]);

  return {
    action,
    actions,
    target,
    reference,
    comparison,
    decision,
    policyError,
    sourceChoices,
    destinations,
    destinationValue,
    destination: destination ? { sourceId: destination.sourceId, packageId: destination.packageId } : undefined,
    destinationLabel: destination ? `${destination.sourceName} · ${destination.packageName} · ${skillKey}` : undefined,
    skillKey,
    stage,
    restoreReview,
    localNoWrite,
    localNoWriteResult,
    result,
    operation,
    previewSignature,
    reviewCurrent,
    setAction,
    selectTarget,
    selectReference,
    selectSource,
    retrySource,
    selectDestination,
    setSkillKey,
    reviewEffects,
    refreshPreview,
    apply,
    reviewRestore,
    cancelRestore,
    finishLocalKeep,
    backToCompare,
    showResult,
    refreshObservation,
  } as const;
}
