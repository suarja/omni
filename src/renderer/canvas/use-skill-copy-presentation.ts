import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";

import type {
  ProjectSkillGroup,
  ResourceCatalogue,
  ResourceRecord,
  ResourceRef,
} from "../../domain/resource-catalogue";
import type { CanvasGroup, LogicalSkillNode } from "./spatial/spatial-types";
import type { SkillCopiesState } from "./use-skill-copies";
import type { Route } from "../navigation";

type SkillSheetSelection = Readonly<{
  node: LogicalSkillNode;
  group: ProjectSkillGroup;
  tab: "document" | "metadata";
  initialMember?: Readonly<{ ref: Extract<ResourceRef, { kind: "artifact" }>; relativePath: string }>;
}>;

type Inputs = Readonly<{
  allRecords: readonly ResourceRecord[];
  catalogue: ResourceCatalogue;
  projectionGroups: readonly CanvasGroup[];
  skillCopiesStatus: SkillCopiesState["status"];
  initialSkillCopy?: SkillSheetSelection["initialMember"];
  reveal(resource: ResourceRecord, relativePath?: string): void;
  setInfoRef(ref: ResourceRef): void;
  onNavigate(route: Route): void;
  trigger: MutableRefObject<HTMLElement | null>;
  searchButton: RefObject<HTMLButtonElement | null>;
}>;

export function useSkillCopyPresentation(input: Inputs): Readonly<{
  selection: SkillSheetSelection | null;
  clear(): void;
  open(node: LogicalSkillNode, tab: SkillSheetSelection["tab"]): void;
  searchRecords: readonly ResourceRecord[];
  selectSearchResult(resource: ResourceRecord): void;
}> {
  const [selection, setSelection] = useState<SkillSheetSelection | null>(null);
  const currentSelection = useMemo(() => {
    if (!selection) return null;
    const group = input.projectionGroups.find((candidate) => candidate.id === selection.node.groupId);
    const node = group?.children.find(
      (candidate): candidate is LogicalSkillNode =>
        candidate.kind === "logical-skill" && candidate.skillId === selection.node.skillId,
    );
    return node && group?.projectSkillGroup ? { ...selection, node, group: group.projectSkillGroup } : selection;
  }, [input.projectionGroups, selection]);
  const initialKey = input.initialSkillCopy
    ? JSON.stringify([input.initialSkillCopy.ref, input.initialSkillCopy.relativePath])
    : null;
  const consumedKey = useRef<string | null>(null);
  const searchRecords = useMemo(
    () =>
      input.allRecords.flatMap((resource) => {
        if (
          resource.ref.kind !== "artifact" ||
          resource.ref.entry.kind !== "project" ||
          resource.artifactKind !== "skill"
        )
          return [resource];
        const locations =
          input.catalogue
            .inspect(resource.ref)
            ?.files.filter((file) => file.role === "content" && /\/SKILL\.md$/u.test(file.relativePath)) ?? [];
        return locations.length
          ? locations.map((file) => ({ ...resource, relativePath: file.relativePath }))
          : [resource];
      }),
    [input.allRecords, input.catalogue],
  );

  const clear = useCallback((): void => setSelection(null), []);
  const open = useCallback(
    (node: LogicalSkillNode, tab: SkillSheetSelection["tab"]): void => {
      const group = input.projectionGroups.find((candidate) => candidate.id === node.groupId)?.projectSkillGroup;
      if (!group) return;
      input.trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSelection({ node, group, tab });
    },
    [input.projectionGroups, input.trigger],
  );
  const selectSearchResult = useCallback(
    (resource: ResourceRecord): void => {
      if (
        resource.ref.kind === "artifact" &&
        resource.ref.entry.kind === "project" &&
        resource.artifactKind === "skill" &&
        resource.relativePath?.endsWith("/SKILL.md")
      ) {
        input.onNavigate({
          screen: "resource-canvas",
          context: { kind: "entry", entry: resource.ref.entry },
          initialSkillCopy: { ref: resource.ref, relativePath: resource.relativePath },
        });
        return;
      }
      input.reveal(resource, resource.relativePath);
      input.onNavigate({ screen: "resource-canvas", context: resource.ref });
    },
    [input.onNavigate, input.reveal],
  );

  useEffect(() => {
    const request = input.initialSkillCopy;
    if (
      !request ||
      !initialKey ||
      input.skillCopiesStatus === "idle" ||
      input.skillCopiesStatus === "loading" ||
      consumedKey.current === initialKey
    )
      return;
    consumedKey.current = initialKey;
    const resource = input.catalogue.inspect(request.ref)?.resource;
    if (!resource) return;
    input.reveal(resource, request.relativePath);
    if (input.skillCopiesStatus !== "ready") {
      input.setInfoRef(request.ref);
      return;
    }
    const node = input.projectionGroups
      .flatMap((group) => group.children)
      .find(
        (candidate): candidate is LogicalSkillNode =>
          candidate.kind === "logical-skill" &&
          candidate.members.some(
            (member) =>
              JSON.stringify(member.ref) === JSON.stringify(request.ref) &&
              `${member.location.folderPath}/SKILL.md` === request.relativePath,
          ),
      );
    if (!node) {
      input.setInfoRef(request.ref);
      return;
    }
    const group = input.projectionGroups.find((candidate) => candidate.id === node.groupId)?.projectSkillGroup;
    if (!group) return;
    input.trigger.current = input.searchButton.current;
    setSelection({ node, group, tab: "document", initialMember: request });
  }, [
    initialKey,
    input.catalogue,
    input.initialSkillCopy,
    input.projectionGroups,
    input.reveal,
    input.searchButton,
    input.setInfoRef,
    input.skillCopiesStatus,
    input.trigger,
  ]);

  return { selection: currentSelection, clear, open, searchRecords, selectSearchResult };
}
