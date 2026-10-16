import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ResourceCatalogue,
  ResourceListing,
  ResourceRecord,
  ResourceRef,
} from "../../../domain/resource-catalogue";
import type { SkillManagedAttention, SkillCorrelation } from "../../../domain/skill-reconciliation/types";
import type { SkillAttentionSummary } from "../../../domain/skill-reconciliation/attention";
import type { RetainedSkillCopies } from "../../../shared/skill-reconciliation-ipc";
import { canvasContextKey, projectCanvas } from "./canvas-projection";
import type { Camera, CanvasProjection, CanvasSession, CanvasViewState } from "./spatial-types";

type NavigationInputs = Readonly<{
  listing: ResourceListing;
  catalogue: ResourceCatalogue;
  session: CanvasSession;
  logicalCopies?: ReadonlyMap<string, SkillCorrelation>;
  retainedSkills?: readonly RetainedSkillCopies[];
  projectAttention?: ReadonlyMap<string, SkillAttentionSummary>;
  managedAttention?: readonly SkillManagedAttention[];
  isBlocked: () => boolean;
}>;
type CanvasNavigation = Readonly<{
  projection: CanvasProjection;
  groupId: string | null;
  viewKey: string;
  selectedPath?: string;
  selection?: CanvasViewState["selection"];
  initialCamera?: Camera;
  selectGroup(groupId: string | null): void;
  reveal(resource: ResourceRecord, relativePath?: string): void;
  storeCamera(camera: Camera): void;
  leaveGroup(): boolean;
}>;
type LocalGroup = Readonly<{ contextKey: string; groupId: string | null }>;

function sameRef(left: ResourceRef, right: ResourceRef): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectionKey(viewKey: string): string {
  return `${viewKey}:selection`;
}

function hasSelection(catalogue: ResourceCatalogue, selection: CanvasViewState["selection"]): boolean {
  if (!selection) return false;
  const details = catalogue.inspect(selection.ref);
  if (!details) return false;
  return !selection.relativePath || details.files.some((file) => file.relativePath === selection.relativePath);
}

function selectionGroup(overview: CanvasProjection, resource: ResourceRecord, path: string | undefined): string | null {
  if (!path) return null;
  return (
    overview.groups.find((group) =>
      group.children.some((node) => {
        if (node.kind === "resource") return sameRef(node.resource.ref, resource.ref) && node.relativePath === path;
        return (
          node.kind === "logical-skill" &&
          node.members.some(
            (member) => sameRef(member.ref, resource.ref) && `${member.location.folderPath}/SKILL.md` === path,
          )
        );
      }),
    )?.id ?? null
  );
}

export function useCanvasNavigation(input: NavigationInputs): CanvasNavigation {
  const baseKey = canvasContextKey(input.listing.context);
  const baseProjection = useMemo(
    () =>
      projectCanvas(
        input.listing,
        input.catalogue,
        null,
        input.logicalCopies,
        input.retainedSkills,
        input.projectAttention,
        input.managedAttention,
      ),
    [
      input.catalogue,
      input.listing,
      input.logicalCopies,
      input.managedAttention,
      input.projectAttention,
      input.retainedSkills,
    ],
  );
  const savedBase = input.session.read(baseKey);
  const [localGroup, setLocalGroup] = useState<LocalGroup>({
    contextKey: baseKey,
    groupId: savedBase?.groupId ?? null,
  });
  const groupCandidate = localGroup.contextKey === baseKey ? localGroup.groupId : (savedBase?.groupId ?? null);
  const projection = useMemo(
    () =>
      projectCanvas(
        input.listing,
        input.catalogue,
        groupCandidate,
        input.logicalCopies,
        input.retainedSkills,
        input.projectAttention,
        input.managedAttention,
      ),
    [
      groupCandidate,
      input.catalogue,
      input.listing,
      input.logicalCopies,
      input.managedAttention,
      input.projectAttention,
      input.retainedSkills,
    ],
  );
  const groupId = projection.key === baseKey ? null : groupCandidate;
  const viewKey = projection.key;
  const storedSelection =
    input.session.read(selectionKey(viewKey))?.selection ??
    (savedBase?.groupId === groupId ? savedBase.selection : undefined);
  const selection = hasSelection(input.catalogue, storedSelection) ? storedSelection : undefined;
  const initialCamera = savedBase?.cameras[viewKey];
  const groupRef = useRef(groupId);
  groupRef.current = groupId;

  const writeBase = useCallback(
    (next: CanvasViewState): void => {
      input.session.write(baseKey, next);
    },
    [baseKey, input.session],
  );

  const selectGroup = useCallback(
    (nextGroup: string | null): void => {
      if (input.isBlocked()) return;
      if (nextGroup !== null && !baseProjection.groups.some((group) => group.id === nextGroup)) return;
      const previous = input.session.read(baseKey) ?? { groupId: groupRef.current, cameras: {} };
      const targetKey = nextGroup ? `${baseKey}:group:${nextGroup}` : baseKey;
      const nextSelection = input.session.read(selectionKey(targetKey))?.selection;
      const targetSelection = hasSelection(input.catalogue, nextSelection) ? nextSelection : undefined;
      writeBase({
        ...previous,
        groupId: nextGroup,
        ...(targetSelection ? { selection: targetSelection } : { selection: undefined }),
      });
      input.session.write(selectionKey(targetKey), {
        groupId: nextGroup,
        cameras: {},
        ...(targetSelection ? { selection: targetSelection } : {}),
      });
      groupRef.current = nextGroup;
      setLocalGroup({ contextKey: baseKey, groupId: nextGroup });
    },
    [baseKey, baseProjection.groups, input.catalogue, input.isBlocked, input.session, writeBase],
  );

  const reveal = useCallback(
    (resource: ResourceRecord, relativePath?: string): void => {
      if (input.isBlocked()) return;
      const details = input.catalogue.inspect(resource.ref);
      if (!details) return;
      const candidate = relativePath ?? resource.relativePath;
      const selectedPath =
        candidate && details.files.some((file) => file.relativePath === candidate) ? candidate : undefined;
      const targetListing = input.catalogue.browse(resource.ref);
      const targetBaseKey = canvasContextKey(targetListing.context);
      const currentView = targetBaseKey === baseKey;
      const targetProjection = currentView
        ? baseProjection
        : projectCanvas(
            targetListing,
            input.catalogue,
            null,
            input.logicalCopies,
            input.retainedSkills,
            input.projectAttention,
            input.managedAttention,
          );
      const previous = input.session.read(targetBaseKey) ?? { groupId: null, cameras: {} };
      const retainedGroup = currentView ? groupRef.current : previous.groupId;
      const validGroup = targetProjection.groups.some((group) => group.id === retainedGroup) ? retainedGroup : null;
      const nextGroup = selectionGroup(targetProjection, resource, selectedPath) ?? validGroup;
      const targetKey = nextGroup ? `${targetBaseKey}:group:${nextGroup}` : targetBaseKey;
      const nextSelection: CanvasViewState["selection"] = {
        ref: resource.ref,
        ...(selectedPath ? { relativePath: selectedPath } : {}),
      };
      const currentSelection = input.session.read(selectionKey(targetKey))?.selection;
      if (
        previous.groupId === nextGroup &&
        currentSelection &&
        sameRef(currentSelection.ref, resource.ref) &&
        currentSelection.relativePath === selectedPath
      )
        return;
      const viewState = input.session.read(selectionKey(targetKey)) ?? { groupId: nextGroup, cameras: {} };
      input.session.write(selectionKey(targetKey), { ...viewState, groupId: nextGroup, selection: nextSelection });
      input.session.write(targetBaseKey, { ...previous, groupId: nextGroup, selection: nextSelection });
      if (currentView) {
        groupRef.current = nextGroup;
        setLocalGroup({ contextKey: baseKey, groupId: nextGroup });
      }
    },
    [
      baseKey,
      baseProjection,
      input.catalogue,
      input.isBlocked,
      input.logicalCopies,
      input.managedAttention,
      input.projectAttention,
      input.retainedSkills,
      input.session,
    ],
  );

  const storeCamera = useCallback(
    (camera: Camera): void => {
      if (input.isBlocked()) return;
      const previous = input.session.read(baseKey) ?? { groupId, cameras: {} };
      writeBase({
        ...previous,
        groupId,
        cameras: { ...previous.cameras, [viewKey]: camera },
        ...(selection ? { selection } : {}),
      });
    },
    [baseKey, groupId, input.isBlocked, input.session, selection, viewKey, writeBase],
  );

  const leaveGroup = useCallback((): boolean => {
    if (input.isBlocked() || !groupRef.current) return false;
    selectGroup(null);
    return true;
  }, [input.isBlocked, selectGroup]);

  useEffect(() => {
    if (input.listing.status === "loading" || input.listing.status === "unobserved") return;
    if (groupCandidate && !groupId) {
      const previous = input.session.read(baseKey) ?? { groupId: null, cameras: {} };
      writeBase({ ...previous, groupId: null });
      groupRef.current = null;
      setLocalGroup({ contextKey: baseKey, groupId: null });
    }
  }, [baseKey, groupCandidate, groupId, input.listing.status, input.session, writeBase]);

  useEffect(() => {
    if (input.listing.status === "loading" || input.listing.status === "unobserved") return;
    if (!storedSelection || selection) return;
    input.session.write(selectionKey(viewKey), { groupId, cameras: {} });
    if (savedBase?.selection && sameRef(savedBase.selection.ref, storedSelection.ref)) {
      const { selection: _removed, ...remaining } = savedBase;
      writeBase(remaining);
    }
  }, [groupId, input.listing.status, input.session, savedBase, selection, storedSelection, viewKey, writeBase]);

  return {
    projection,
    groupId,
    viewKey,
    selection,
    ...(selection?.relativePath ? { selectedPath: selection.relativePath } : {}),
    ...(initialCamera ? { initialCamera } : {}),
    selectGroup,
    reveal,
    storeCamera,
    leaveGroup,
  };
}
