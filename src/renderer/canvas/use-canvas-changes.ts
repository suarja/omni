import { useCallback, useEffect, useRef, useState } from "react";

import type { ResourceContext, ResourceRef } from "../../domain/resource-catalogue";
import type { WriteSkillRequest } from "../../shared/operations-write-skill-ipc";
import type { SkillIntent } from "../../shared/skill-management-ipc";
import type { SkillLocationKey } from "../../domain/skill-reconciliation/types";

export type ManagedResolutionSelection = Readonly<{ skillId: string; location: SkillLocationKey }>;

export type CanvasChangesOpenOptions = Readonly<{
  sourceId?: string;
  packageId?: string;
  request?: WriteSkillRequest;
  skillIntent?: SkillIntent;
  skillIntentId?: string;
  requestId?: string;
  projectId?: string;
  journey?: "draft" | "assign";
  removalBindingIds?: readonly string[];
  managedResolution?: ManagedResolutionSelection;
}>;

export function useCanvasChanges(
  options: Readonly<{
    context: ResourceContext;
    centerRef?: ResourceRef;
    detailsRef?: ResourceRef;
    initialRequest?: WriteSkillRequest;
    initialSkillIntent?: SkillIntent;
    initialSkillIntentId?: string;
    requestId?: string;
    initialRestoreOperationId?: string;
    initialResultId?: string;
    isBlocked: () => boolean;
    dismissOtherSheets: (preserveSkillSheet?: boolean) => void;
    rememberOpener: () => void;
    focusOpener?: () => void;
    focusResourceNode: (ref: ResourceRef | undefined) => void;
  }>,
) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<WriteSkillRequest | undefined>();
  const [skillIntent, setSkillIntent] = useState<SkillIntent | undefined>();
  const [skillIntentId, setSkillIntentId] = useState<string | undefined>();
  const [resultId, setResultId] = useState<string | undefined>();
  const [requestId, setRequestId] = useState<string | undefined>();
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [packageId, setPackageId] = useState<string | undefined>();
  const [projectId, setProjectId] = useState<string | undefined>();
  const [removalBindingIds, setRemovalBindingIds] = useState<readonly string[] | undefined>();
  const [restoreOperationId, setRestoreOperationId] = useState<string | undefined>();
  const [managedResolution, setManagedResolution] = useState<ManagedResolutionSelection | undefined>();
  const [journey, setJourney] = useState<"draft" | "assign">("draft");
  const focusRef = useRef<ResourceRef | null>(null);
  const focusOpenerOnClose = useRef(false);

  const close = useCallback((): void => {
    const restoreOpener = focusOpenerOnClose.current;
    focusOpenerOnClose.current = false;
    setOpen(false);
    setResultId(undefined);
    setRequest(undefined);
    setSkillIntent(undefined);
    setSkillIntentId(undefined);
    setRequestId(undefined);
    setSourceId(undefined);
    setPackageId(undefined);
    setRemovalBindingIds(undefined);
    setRestoreOperationId(undefined);
    setManagedResolution(undefined);
    requestAnimationFrame(() => {
      if (restoreOpener) options.focusOpener?.();
      else options.focusResourceNode(focusRef.current ?? options.centerRef);
    });
  }, [options.centerRef, options.focusOpener, options.focusResourceNode]);

  const show = useCallback(
    (next: CanvasChangesOpenOptions = {}): void => {
      if (options.isBlocked()) return;
      focusRef.current = options.detailsRef ?? options.centerRef ?? null;
      focusOpenerOnClose.current = next.skillIntent?.kind === "reconcile" || Boolean(next.managedResolution);
      options.rememberOpener();
      options.dismissOtherSheets(focusOpenerOnClose.current);
      setResultId(undefined);
      setRequest(next.request);
      setSkillIntent(next.skillIntent);
      setSkillIntentId(next.skillIntentId);
      setRequestId(next.requestId);
      setSourceId(next.sourceId);
      setPackageId(next.packageId);
      setRemovalBindingIds(next.removalBindingIds);
      setRestoreOperationId(undefined);
      setManagedResolution(next.managedResolution);
      setProjectId(next.projectId);
      setJourney(next.journey ?? (next.projectId ? "assign" : "draft"));
      setOpen(true);
    },
    [options.centerRef, options.detailsRef, options.dismissOtherSheets, options.isBlocked, options.rememberOpener],
  );

  useEffect(() => {
    if (!options.initialRequest) return;
    focusRef.current = { kind: "entry", entry: { kind: "source", id: options.initialRequest.sourceId } };
    options.dismissOtherSheets();
    setSourceId(options.initialRequest.sourceId);
    setPackageId(options.initialRequest.packageId);
    setProjectId(undefined);
    setJourney("draft");
    setRemovalBindingIds(undefined);
    setRestoreOperationId(undefined);
    setManagedResolution(undefined);
    setRequest(options.initialRequest);
    setSkillIntent(undefined);
    setSkillIntentId(undefined);
    setRequestId(options.requestId);
    setOpen(true);
  }, [options.dismissOtherSheets, options.initialRequest, options.requestId]);

  useEffect(() => {
    if (!options.initialSkillIntent) return;
    focusRef.current = options.context.kind === "workspace" ? null : { kind: "entry", entry: options.context.entry };
    options.dismissOtherSheets();
    setResultId(undefined);
    setRequest(undefined);
    setSkillIntent(options.initialSkillIntent);
    setSkillIntentId(options.initialSkillIntentId);
    setRequestId(options.requestId);
    setSourceId(undefined);
    setPackageId(undefined);
    setProjectId(undefined);
    setRemovalBindingIds(undefined);
    setRestoreOperationId(undefined);
    setManagedResolution(undefined);
    setOpen(true);
  }, [
    options.context,
    options.dismissOtherSheets,
    options.initialSkillIntent,
    options.initialSkillIntentId,
    options.requestId,
  ]);

  useEffect(() => {
    if (!options.initialRestoreOperationId) return;
    const entry = options.context.kind === "workspace" ? undefined : options.context.entry;
    focusRef.current = entry ? { kind: "entry", entry } : null;
    options.dismissOtherSheets();
    setResultId(undefined);
    setRequest(undefined);
    setRequestId(undefined);
    setSourceId(undefined);
    setPackageId(undefined);
    setProjectId(entry?.kind === "project" ? entry.id : undefined);
    setRemovalBindingIds(undefined);
    setRestoreOperationId(options.initialRestoreOperationId);
    setOpen(true);
  }, [options.context, options.dismissOtherSheets, options.initialRestoreOperationId]);

  useEffect(() => {
    if (!options.initialResultId) return;
    focusRef.current = options.context.kind === "workspace" ? null : { kind: "entry", entry: options.context.entry };
    options.dismissOtherSheets();
    setRequest(undefined);
    setSkillIntent(undefined);
    setSkillIntentId(undefined);
    setRequestId(undefined);
    setRemovalBindingIds(undefined);
    setRestoreOperationId(undefined);
    setSourceId(undefined);
    setPackageId(undefined);
    setProjectId(undefined);
    setJourney("draft");
    setResultId(options.initialResultId);
    setOpen(true);
  }, [options.context, options.dismissOtherSheets, options.initialResultId]);

  return {
    open,
    request,
    skillIntent,
    skillIntentId,
    requestId,
    resultId,
    sourceId,
    packageId,
    projectId,
    removalBindingIds,
    managedResolution,
    restoreOperationId,
    journey,
    show,
    close,
  } as const;
}
