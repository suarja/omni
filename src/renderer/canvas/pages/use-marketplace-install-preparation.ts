import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillIntent } from "../../../shared/skill-management-ipc";
import type { ResourceCanvasProps } from "../resource-canvas-types";
import { projectHarnesses } from "../project-view-model";

type Inputs = Readonly<{
  sourceId?: string;
  packageId?: string;
  artifactPath?: string;
  eligibleProjectIds: readonly string[];
  onEnsureGrant: ResourceCanvasProps["onEnsureGrant"];
}>;
export function useMarketplaceInstallPreparation(input: Inputs): Readonly<{
  intent: SkillIntent | null;
  error: string | null;
  preparing: boolean;
  select: (ids: readonly string[]) => void;
  prepare: (ids: readonly string[]) => Promise<void>;
  back: () => void;
}> {
  const latest = useRef(input);
  latest.current = input;
  const selected = useRef<readonly string[]>([]);
  const generation = useRef(0);
  const identity = JSON.stringify([input.sourceId, input.packageId, input.artifactPath]);
  const [intent, setIntent] = useState<SkillIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const select = useCallback((ids: readonly string[]): void => {
    if (JSON.stringify(selected.current) === JSON.stringify(ids)) return;
    selected.current = ids;
    generation.current++;
    setPreparing(false);
    setError(null);
  }, []);
  useEffect(() => {
    generation.current++;
    selected.current = [];
    setIntent(null);
    setError(null);
    setPreparing(false);
    return () => {
      generation.current++;
    };
  }, [identity]);
  async function prepare(ids: readonly string[]): Promise<void> {
    const ticket = ++generation.current;
    const request = latest.current;
    const current = (): boolean =>
      ticket === generation.current &&
      request.sourceId === latest.current.sourceId &&
      request.packageId === latest.current.packageId &&
      request.artifactPath === latest.current.artifactPath &&
      JSON.stringify(ids) === JSON.stringify(selected.current) &&
      ids.every((id) => latest.current.eligibleProjectIds.includes(id));
    if (!request.sourceId || !request.packageId || !request.artifactPath || !ids.length || !current()) return;
    setPreparing(true);
    setError(null);
    try {
      const sourceGrant = await request.onEnsureGrant({ kind: "source", id: request.sourceId });
      if (!current()) return;
      if (!sourceGrant) throw new Error("The marketplace is inaccessible. Reopen it before installing.");
      for (const id of ids) {
        const grant = await request.onEnsureGrant({ kind: "project", id });
        if (!current()) return;
        if (!grant) throw new Error(`Project ${id} is inaccessible. Reopen it before installing.`);
      }
      if (current())
        setIntent({
          kind: "assign",
          sourceId: request.sourceId,
          packageId: request.packageId,
          artifactPath: request.artifactPath,
          targets: ids.map((projectId) => ({ projectId, harnessIds: projectHarnesses })),
        });
    } catch (failure) {
      if (current())
        setError(
          failure instanceof Error
            ? failure.message
            : "Installation access could not be acquired. Reopen the marketplace.",
        );
    } finally {
      if (ticket === generation.current) setPreparing(false);
    }
  }
  return { intent, error, preparing, select, prepare, back: () => setIntent(null) };
}
