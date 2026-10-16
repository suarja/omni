import { useEffect, useMemo, useRef, useState } from "react";

import type { ProjectSkillGroup } from "../../domain/resource-catalogue";
import type { EntryRef } from "../../domain/project-source-registry";
import type { SkillCorrelation, ManagedSkillUse, SkillManagedAttention } from "../../domain/skill-reconciliation/types";
import type { DesktopApi } from "../../shared/ipc";
import type { RetainedSkillCopies, SkillCopiesGroupRequest } from "../../shared/skill-reconciliation-ipc";

export type SkillCopiesState =
  | Readonly<{
      status: "idle" | "loading" | "unavailable";
      byGroup: ReadonlyMap<string, SkillCorrelation>;
      retainedSkills: readonly RetainedSkillCopies[];
    }>
  | Readonly<{
      status: "ready";
      byGroup: ReadonlyMap<string, SkillCorrelation>;
      retainedSkills: readonly RetainedSkillCopies[];
      managedUses: readonly ManagedSkillUse[];
      managedAttention: readonly SkillManagedAttention[];
      storeRevision: number;
    }>;

type Inputs = Readonly<{
  projectId?: string;
  groups: readonly ProjectSkillGroup[];
  observationKey?: string;
  api: Pick<DesktopApi, "observeSkillCopies"> | null;
  onEnsureGrant: (entry: EntryRef) => Promise<string | null>;
}>;
type KeyedState = Readonly<{ key: string; value: SkillCopiesState }>;

function requestGroups(groups: readonly ProjectSkillGroup[]): readonly SkillCopiesGroupRequest[] {
  return groups.map((group) => ({
    groupId: group.id,
    members: group.locations.map((location) => ({
      ref: location.ref,
      relativePath: location.relativePath,
    })),
  }));
}

export function useSkillCopies(input: Inputs): SkillCopiesState {
  const requests = useMemo(() => requestGroups(input.groups), [input.groups]);
  const requestKey = JSON.stringify(requests);
  const apiRef = useRef(input.api);
  const ensureGrantRef = useRef(input.onEnsureGrant);
  const generation = useRef(0);
  const key = JSON.stringify([input.projectId ?? null, requestKey, input.observationKey ?? null]);
  const [savedState, setSavedState] = useState<KeyedState>({
    key: "",
    value: { status: "idle", byGroup: new Map(), retainedSkills: [] },
  });
  const state = useMemo(
    () =>
      savedState.key === key ? savedState.value : { status: "idle" as const, byGroup: new Map(), retainedSkills: [] },
    [key, savedState],
  );
  apiRef.current = input.api;
  ensureGrantRef.current = input.onEnsureGrant;

  useEffect(() => {
    const requestId = ++generation.current;
    if (!input.projectId || !apiRef.current?.observeSkillCopies) {
      setSavedState({ key, value: { status: "unavailable", byGroup: new Map(), retainedSkills: [] } });
      return () => {
        generation.current += 1;
      };
    }
    setSavedState({ key, value: { status: "loading", byGroup: new Map(), retainedSkills: [] } });
    void (async () => {
      try {
        const entry: EntryRef = { kind: "project", id: input.projectId! };
        const grantHandle = await ensureGrantRef.current(entry);
        if (generation.current !== requestId) return;
        if (!grantHandle) {
          setSavedState({ key, value: { status: "unavailable", byGroup: new Map(), retainedSkills: [] } });
          return;
        }
        const api = apiRef.current;
        if (!api?.observeSkillCopies) {
          setSavedState({ key, value: { status: "unavailable", byGroup: new Map(), retainedSkills: [] } });
          return;
        }
        const response = await api.observeSkillCopies({
          projectId: input.projectId!,
          grantHandle,
          groups: requests,
        });
        if (generation.current !== requestId) return;
        if (response.status !== "ready") {
          setSavedState({ key, value: { status: "unavailable", byGroup: new Map(), retainedSkills: [] } });
          return;
        }
        setSavedState({
          key,
          value: {
            status: "ready",
            storeRevision: response.storeRevision,
            byGroup: new Map(response.groups.map((group) => [group.groupId, group.correlation])),
            retainedSkills: response.retainedSkills,
            managedUses: response.managedUses,
            managedAttention: response.managedAttention ?? [],
          },
        });
      } catch {
        if (generation.current === requestId)
          setSavedState({ key, value: { status: "unavailable", byGroup: new Map(), retainedSkills: [] } });
      }
    })();
    return () => {
      generation.current += 1;
    };
    // Grants rerender the parent; only a new observation or member set should rescan.
  }, [input.projectId, key]);

  return state;
}
