import { useCallback, useEffect, useRef, useState } from "react";

import type { SkillLocationKey } from "../../../domain/skill-reconciliation/types";
import type { EntryRef } from "../../../domain/project-source-registry";
import type { DesktopApi } from "../../../shared/ipc";
import type { SkillCopyComparisonResponse } from "../../../shared/skill-copy-comparison-ipc";

export type SkillCopyComparisonPair = Readonly<{ a: SkillLocationKey; b: SkillLocationKey }>;
type Pair = SkillCopyComparisonPair;
type ReadyResponse = Extract<SkillCopyComparisonResponse, { status: "ready" }>;
type UnavailableResponse = Extract<SkillCopyComparisonResponse, { status: "unavailable" }>;
export type SkillCopyComparisonState =
  | Readonly<{ status: "loading"; pair: Pair | null; selectedPath?: string }>
  | Readonly<{ status: "ready"; pair: Pair; response: ReadyResponse; selectedPath?: string }>
  | Readonly<{
      status: "unavailable";
      pair: Pair | null;
      reason: UnavailableResponse["reason"];
      response?: UnavailableResponse;
      selectedPath?: string;
    }>;

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify(location);
}

function sortLocations(locations: readonly SkillLocationKey[]): SkillLocationKey[] {
  const unique = new Map(locations.map((location) => [locationKey(location), location]));
  return [...unique.values()].sort((left, right) => {
    const leftKey = `${left.folderPath}/${left.harnessId}`;
    const rightKey = `${right.folderPath}/${right.harnessId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function createInitialPair(
  locations: readonly SkillLocationKey[],
  initialLeft: SkillLocationKey,
  initialPair?: Pair,
): Pair | null {
  const ordered = sortLocations(locations);
  if (initialPair) {
    const a = ordered.find((location) => locationKey(location) === locationKey(initialPair.a));
    const b = ordered.find((location) => locationKey(location) === locationKey(initialPair.b));
    return a && b && locationKey(a) !== locationKey(b) ? { a, b } : null;
  }
  const initialIndex = ordered.findIndex((location) => locationKey(location) === locationKey(initialLeft));
  const index = initialIndex < 0 ? 0 : initialIndex;
  const a = ordered[index];
  const b = ordered.length > 1 ? ordered[(index + 1) % ordered.length] : undefined;
  return a && b ? { a, b } : null;
}

export function useSkillCopyComparison(
  input: Readonly<{
    api: Pick<DesktopApi, "compareSkillCopies"> | null;
    projectId: string;
    skillId: string;
    locations: readonly SkillLocationKey[];
    initialLeft: SkillLocationKey;
    initialPair?: Pair;
    onEnsureGrant: (entry: EntryRef) => Promise<string | null>;
  }>,
): Readonly<{
  pair: Pair | null;
  state: SkillCopyComparisonState;
  selectSide(side: "a" | "b", location: SkillLocationKey): void;
  selectPair(pair: Pair): void;
  selectFile(path: string): void;
  refresh(): void;
}> {
  const [pair, setPair] = useState<Pair | null>(() =>
    createInitialPair(input.locations, input.initialLeft, input.initialPair),
  );
  const [state, setState] = useState<SkillCopyComparisonState>(() => ({ status: "loading", pair }));
  const initialPair = useRef(pair);
  const generation = useRef(0);
  const apiRef = useRef(input.api);
  const grantRef = useRef(input.onEnsureGrant);
  apiRef.current = input.api;
  grantRef.current = input.onEnsureGrant;

  const load = useCallback(
    async (nextPair: Pair | null, filePath?: string): Promise<void> => {
      const requestId = ++generation.current;
      setState({ status: "loading", pair: nextPair, ...(filePath ? { selectedPath: filePath } : {}) });
      if (!nextPair) {
        setState({ status: "unavailable", pair: null, reason: "membership" });
        return;
      }
      try {
        const grantHandle = await grantRef.current({ kind: "project", id: input.projectId });
        if (generation.current !== requestId) return;
        if (!grantHandle) {
          setState({
            status: "unavailable",
            pair: nextPair,
            reason: "grant",
            ...(filePath ? { selectedPath: filePath } : {}),
          });
          return;
        }
        const compare = apiRef.current?.compareSkillCopies;
        if (!compare) {
          setState({
            status: "unavailable",
            pair: nextPair,
            reason: "read",
            ...(filePath ? { selectedPath: filePath } : {}),
          });
          return;
        }
        const response = await compare({
          projectId: input.projectId,
          grantHandle,
          skillId: input.skillId,
          a: nextPair.a,
          b: nextPair.b,
          ...(filePath ? { filePath } : {}),
        });
        if (generation.current !== requestId) return;
        if (response.status === "ready") {
          setState({
            status: "ready",
            pair: nextPair,
            response,
            ...(response.selectedPath ? { selectedPath: response.selectedPath } : {}),
          });
        } else {
          setState({
            status: "unavailable",
            pair: nextPair,
            reason: response.reason,
            response,
            ...(filePath ? { selectedPath: filePath } : {}),
          });
        }
      } catch {
        if (generation.current === requestId) {
          setState({
            status: "unavailable",
            pair: nextPair,
            reason: "read",
            ...(filePath ? { selectedPath: filePath } : {}),
          });
        }
      }
    },
    [input.projectId, input.skillId],
  );

  useEffect(() => {
    void load(initialPair.current);
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const selectSide = useCallback(
    (side: "a" | "b", location: SkillLocationKey): void => {
      if (!pair || locationKey(location) === locationKey(pair[side === "a" ? "b" : "a"])) return;
      const nextPair = { ...pair, [side]: location };
      const filePath = state.selectedPath;
      setPair(nextPair);
      void load(nextPair, filePath);
    },
    [load, pair, state.selectedPath],
  );

  const selectPair = useCallback(
    (nextPair: Pair): void => {
      const ordered = sortLocations(input.locations);
      const a = ordered.find((location) => locationKey(location) === locationKey(nextPair.a));
      const b = ordered.find((location) => locationKey(location) === locationKey(nextPair.b));
      if (!a || !b || locationKey(a) === locationKey(b)) return;
      setPair({ a, b });
      void load({ a, b });
    },
    [input.locations, load],
  );

  const selectFile = useCallback(
    (path: string): void => {
      if (!pair) return;
      void load(pair, path);
    },
    [load, pair],
  );

  const refresh = useCallback((): void => {
    void load(pair, state.selectedPath);
  }, [load, pair, state.selectedPath]);

  return { pair, state, selectSide, selectPair, selectFile, refresh };
}
