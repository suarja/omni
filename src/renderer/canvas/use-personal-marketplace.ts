import { GRANT_REUSE_MS } from "../grant-manager";
import { activeWorkshop } from "../../domain/source-roles";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Observation } from "../../domain/project-source-registry";
import { parseObservationResponse } from "../../shared/registry-ipc";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { personalMarketplace } from "./personal-marketplace";
import { useI18n } from "../i18n";

export function usePersonalMarketplace(
  canvas: ResourceCanvasProps,
  observation: "observe" | "cached" = "observe",
): Readonly<{
  marketplace: ReturnType<typeof personalMarketplace>;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}> {
  const { t } = useI18n();
  const source = activeWorkshop(canvas.snapshot.registry);
  const inputs = useRef(canvas);
  inputs.current = canvas;
  const [observed, setObserved] = useState<Observation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(source) && observation === "observe");
  const revision = useRef(0);
  const lastObservation = useRef<Readonly<{ key: string; api: ResourceCanvasProps["api"]; at: number }> | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    if (!source) return;
    const ticket = ++revision.current;
    const current = (): boolean => ticket === revision.current;
    const canvas = inputs.current;
    setError(null);
    setLoading(true);
    try {
      let observation: Observation | null = null;
      if (canvas.onObserveAdoptionSource) observation = await canvas.onObserveAdoptionSource(source.ref.id, current);
      else if (canvas.api?.observeSource) {
        const grantHandle = await canvas.onEnsureGrant(source.ref);
        if (!grantHandle) throw new Error(t("skillActions.marketplaceUnavailable"));
        const result = parseObservationResponse(
          await canvas.api.observeSource({ sourceId: source.ref.id, grantHandle }),
        );
        if (result.status === "observed") observation = result.observation;
        else
          throw new Error(result.status === "corrupt" ? t("skillActions.marketplaceUnavailable") : result.diagnostic);
      } else {
        await canvas.onEnsureGrant(source.ref);
        return;
      }
      if (!current()) return;
      if (!observation) throw new Error(t("skillActions.marketplaceUnavailable"));
      if (observation.subject.kind !== "source" || observation.subject.id !== source.ref.id)
        throw new Error(t("registry.responseIdentityMismatch"));
      lastObservation.current = {
        key: JSON.stringify([source.ref.id, canvas.snapshot.registry.revision]),
        api: canvas.api,
        at: Date.now(),
      };
      setObserved(observation);
    } catch (error) {
      if (current()) {
        setObserved(null);
        setError(error instanceof Error ? error.message : t("skillActions.marketplaceUnavailable"));
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [source?.ref.id, t]);
  useEffect(() => {
    if (observation !== "observe") return;
    const cached = lastObservation.current;
    if (
      cached?.key === JSON.stringify([source?.ref.id, canvas.snapshot.registry.revision]) &&
      cached.api === canvas.api &&
      Date.now() - cached.at < GRANT_REUSE_MS
    )
      return;
    void reload();
  }, [observation, canvas.snapshot.registry.revision, canvas.api, reload]);
  useEffect(
    () => () => {
      revision.current += 1;
    },
    [],
  );
  const roots =
    error && source
      ? canvas.snapshot.roots.map((root) =>
          root.entry.kind === "source" && root.entry.id === source.ref.id
            ? { ...root, evidence: { status: "unobserved" as const } }
            : root,
        )
      : observed && observed.subject.id === source?.ref.id
        ? [
            ...canvas.snapshot.roots.filter((root) => root.entry.kind !== "source" || root.entry.id !== source.ref.id),
            { entry: source.ref, evidence: { status: "observed" as const, observation: observed } },
          ]
        : canvas.snapshot.roots;
  return { marketplace: personalMarketplace({ ...canvas.snapshot, roots }), error, loading, reload };
}
