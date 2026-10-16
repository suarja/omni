import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { EntryRef, Observation } from "../../domain/project-source-registry";
import type { ProjectSkillGroup, ResourceRef, ResourceSnapshot } from "../../domain/resource-catalogue";
import type { ManagedSkillUse, SkillLocationKey } from "../../domain/skill-reconciliation/types";
import type { DesktopApi } from "../../shared/ipc";
import type { SkillResult } from "../../shared/skill-management-ipc";
import { SkillCopiesSheet } from "./SkillCopiesSheet";
import type { LogicalSkillNode } from "./spatial/spatial-types";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { CopyManagementWorkbench } from "./changes/CopyManagementWorkbench";
import { copyLocationKey, copyManagementResultContext } from "./changes/copy-management-view-model";

type ReaderSelection = Readonly<{
  node: LogicalSkillNode;
  group: ProjectSkillGroup;
  tab: "document" | "metadata";
  initialMember?: Readonly<{
    ref: Extract<ResourceRef, { kind: "artifact" }>;
    relativePath: string;
  }>;
}>;
type ManagementSession = Readonly<{
  node: LogicalSkillNode;
  target: SkillLocationKey;
  workflowKey: string;
  opener?: HTMLButtonElement;
  initialResult?: SkillResult;
  initialRestoreReview?: boolean;
  savedRouteId?: string;
}>;
type CanvasSkillCopiesLayerProps = Readonly<{
  api: ResourceCanvasProps["api"];
  onClose: () => void;
  onEnsureGrant: (entry: EntryRef) => Promise<string | null>;
  onObserveAdoptionSource: ResourceCanvasProps["onObserveAdoptionSource"];
  onRefresh: ResourceCanvasProps["onRefresh"];
  onApplyingChange: (active: boolean) => void;
  onOpenChange: (open: boolean) => void;
  reader: ReaderSelection | null;
  snapshot: ResourceSnapshot;
  managedUses: readonly ManagedSkillUse[];
  managedUsesStatus: "ready" | "loading" | "unavailable";
  rootKey?: string;
  visible: boolean;
  operationOpen: boolean;
  backRef: { current: () => void };
  closeRef: { current: () => void };
  copyNodes: readonly LogicalSkillNode[];
  projectId?: string;
  projectStatus: "idle" | "loading" | "ready" | "unavailable";
  savedRouteId?: string;
  initialRestoreReview: boolean;
  onSavedRouteResolved: (id: string, handled: boolean) => void;
}>;

function createWorkflowKey(location: SkillLocationKey, rootKey: string | undefined, skillId: string): string {
  return JSON.stringify([location.projectId, rootKey ?? null, skillId]);
}

function sameLocationSet(left: LogicalSkillNode, right: LogicalSkillNode): boolean {
  const keys = (node: LogicalSkillNode): string[] =>
    node.locations.map(({ location }) => JSON.stringify(location)).sort();
  return JSON.stringify(keys(left)) === JSON.stringify(keys(right));
}

export function CanvasSkillCopiesLayer(props: CanvasSkillCopiesLayerProps): ReactElement | null {
  const [session, setSession] = useState<ManagementSession | null>(null);
  const [savedResult, setSavedResult] = useState<Readonly<{
    id: string;
    status: "loading" | "ready" | "unavailable";
    result?: SkillResult;
  }> | null>(null);
  const savedRouteStarted = useRef<string | null>(null);
  const savedRouteResolved = useRef<string | null>(null);
  const node = props.reader?.node;

  useEffect(() => {
    if (props.savedRouteId) return;
    savedRouteStarted.current = null;
    savedRouteResolved.current = null;
    setSavedResult(null);
  }, [props.savedRouteId]);

  useEffect(() => {
    const id = props.savedRouteId;
    if (!id || savedRouteStarted.current === id) return;
    savedRouteStarted.current = id;
    setSavedResult({ id, status: "loading" });
    const readResult = props.api?.readSkillOperationResult;
    if (!readResult) {
      setSavedResult({ id, status: "unavailable" });
      return;
    }
    void readResult({ intentId: id }).then(
      (result) => setSavedResult(result ? { id, status: "ready", result } : { id, status: "unavailable" }),
      () => setSavedResult({ id, status: "unavailable" }),
    );
  }, [props.api, props.savedRouteId]);

  const savedContext = useMemo(
    () =>
      savedResult?.status === "ready" && savedResult.id === props.savedRouteId
        ? copyManagementResultContext(savedResult.result!)
        : undefined,
    [props.savedRouteId, savedResult],
  );
  const savedNode = useMemo(
    () => (savedContext ? props.copyNodes.find((candidate) => candidate.skillId === savedContext.skillId) : undefined),
    [props.copyNodes, savedContext],
  );
  const savedMember = useMemo(
    () =>
      savedNode?.members.find((member) => copyLocationKey(member.location) === copyLocationKey(savedContext!.location)),
    [savedContext, savedNode],
  );

  useEffect(() => {
    const id = props.savedRouteId;
    if (!id || savedRouteResolved.current === id || !savedResult || savedResult.id !== id) return;
    if (savedResult.status === "loading") return;
    if (savedResult.status === "unavailable" || !savedResult.result || !savedContext) {
      savedRouteResolved.current = id;
      props.onSavedRouteResolved(id, false);
      return;
    }
    if (
      !props.projectId ||
      props.projectId !== savedContext.location.projectId ||
      props.projectStatus === "unavailable"
    ) {
      savedRouteResolved.current = id;
      props.onSavedRouteResolved(id, false);
      return;
    }
    if (props.projectStatus === "loading" || props.projectStatus === "idle") return;
    if (props.projectStatus !== "ready" || !savedNode || !savedMember) {
      savedRouteResolved.current = id;
      props.onSavedRouteResolved(id, false);
      return;
    }
    const activeElement = document.activeElement;
    const opener = activeElement instanceof HTMLButtonElement ? activeElement : undefined;
    const target = savedContext.location;
    setSession({
      node: savedNode,
      target,
      workflowKey: createWorkflowKey(target, props.rootKey, savedNode.skillId),
      ...(opener ? { opener } : {}),
      initialResult: savedResult.result,
      initialRestoreReview: props.initialRestoreReview,
      savedRouteId: id,
    });
    savedRouteResolved.current = id;
    props.onOpenChange(true);
    props.onSavedRouteResolved(id, true);
  }, [
    props.initialRestoreReview,
    props.onOpenChange,
    props.onSavedRouteResolved,
    props.projectId,
    props.projectStatus,
    props.rootKey,
    props.savedRouteId,
    savedContext,
    savedMember,
    savedNode,
    savedResult,
  ]);

  useEffect(() => {
    if (!session) return;
    if (session.savedRouteId && session.initialResult) {
      if (props.savedRouteId !== session.savedRouteId) {
        setSession(null);
        props.onOpenChange(false);
        return;
      }
      // Refresh temporarily clears copy nodes; it does not invalidate a durable result.
      if (
        props.projectId === session.target.projectId &&
        session.workflowKey === createWorkflowKey(session.target, props.rootKey, session.node.skillId) &&
        (props.projectStatus === "idle" || props.projectStatus === "loading")
      )
        return;
      const currentNode = props.copyNodes.find((candidate) => candidate.skillId === session.node.skillId);
      if (
        !currentNode ||
        !sameLocationSet(currentNode, session.node) ||
        session.workflowKey !== createWorkflowKey(session.target, props.rootKey, session.node.skillId)
      ) {
        setSession(null);
        props.onOpenChange(false);
        props.onSavedRouteResolved(session.savedRouteId, false);
      }
      return;
    }
    if (
      !props.reader ||
      props.reader.node.skillId !== session.node.skillId ||
      !sameLocationSet(props.reader.node, session.node) ||
      session.workflowKey !== createWorkflowKey(session.target, props.rootKey, session.node.skillId)
    ) {
      setSession(null);
      props.onOpenChange(false);
    }
  }, [
    props.copyNodes,
    props.onOpenChange,
    props.onSavedRouteResolved,
    props.reader,
    props.rootKey,
    props.projectId,
    props.projectStatus,
    props.savedRouteId,
    session,
  ]);

  if (!props.visible) return null;
  const activeNode = session?.savedRouteId
    ? (props.copyNodes.find((candidate) => candidate.skillId === session.node.skillId) ?? session.node)
    : session && node?.skillId === session.node.skillId
      ? node
      : session?.node;
  const openManagement = (target: SkillLocationKey, opener: HTMLButtonElement): void => {
    if (!props.reader || props.operationOpen) return;
    setSession({
      node: props.reader.node,
      target,
      opener,
      workflowKey: createWorkflowKey(target, props.rootKey, props.reader.node.skillId),
    });
    props.onOpenChange(true);
  };
  const backToReader = (): void => {
    const opener = session?.opener;
    setSession(null);
    props.onOpenChange(false);
    if (props.reader) requestAnimationFrame(() => opener?.focus());
    else props.onClose();
  };
  props.backRef.current = session ? backToReader : () => undefined;
  const closeManagement = (): void => {
    setSession(null);
    props.onOpenChange(false);
    props.onClose();
  };
  props.closeRef.current = session ? closeManagement : () => undefined;
  const api = props.api;
  return (
    <>
      {props.reader ? (
        <SkillCopiesSheet
          api={
            api?.readArtifact
              ? {
                  readArtifact: api.readArtifact,
                  ...(api.readSkillVariantOrigin ? { readSkillVariantOrigin: api.readSkillVariantOrigin } : {}),
                }
              : null
          }
          group={props.reader.group}
          initialMember={props.reader.initialMember}
          initialTab={props.reader.tab}
          key={JSON.stringify([props.reader.node.skillId, props.reader.initialMember ?? null, props.reader.tab])}
          node={props.reader.node}
          onClose={props.onClose}
          onCompare={openManagement}
          onEnsureGrant={props.onEnsureGrant}
          inert={Boolean(session) || props.operationOpen}
          snapshot={props.snapshot}
        />
      ) : null}
      {session && activeNode ? (
        <CopyManagementWorkbench
          api={api}
          initialTarget={session.target}
          initialResult={session.initialResult}
          initialRestoreReview={session.initialRestoreReview}
          key={session.workflowKey}
          hasReader={Boolean(props.reader)}
          managedUses={props.managedUses}
          managedUsesStatus={props.managedUsesStatus}
          node={activeNode}
          onApplyingChange={props.onApplyingChange}
          onBack={backToReader}
          onClose={closeManagement}
          onEnsureGrant={props.onEnsureGrant}
          onObserveSource={props.onObserveAdoptionSource}
          onRefresh={props.onRefresh}
          snapshot={props.snapshot}
          workflowKey={session.workflowKey}
        />
      ) : null}
    </>
  );
}
