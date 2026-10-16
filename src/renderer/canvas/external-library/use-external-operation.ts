import { useEffect, useRef, useState } from "react";
import type { ResourceCanvasProps } from "../resource-canvas-types";
import {
  parseSkillPreview,
  parseSkillResult,
  type SkillIntent,
  type SkillPreview,
  type SkillResult,
} from "../../../shared/skill-management-ipc";

export function useExternalOperation(
  canvas: ResourceCanvasProps,
  intents: readonly SkillIntent[],
  onApplyingChange: (busy: boolean) => void,
  onChanged: () => Promise<void>,
  evidenceKey = "",
): Readonly<{
  previews: readonly SkillPreview[];
  results: readonly SkillResult[];
  busy: boolean;
  applying: boolean;
  error: string | null;
  ready: boolean;
  apply: () => Promise<void>;
}> {
  const [reviewed, setReviewed] = useState<Readonly<{ key: string; previews: readonly SkillPreview[] }>>({
    key: "",
    previews: [],
  });
  const [results, setResults] = useState<readonly SkillResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([intents, evidenceKey]);
  const previews = reviewed.key === key ? reviewed.previews : [];
  const locked = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const ticket = ++generation.current;
    setReviewed({ key, previews: [] });
    setError(null);
    setBusy(Boolean(intents.length));
    if (!intents.length) return;
    void (async () => {
      if (!canvas.api?.previewSkillOperation)
        throw new Error("Skill operation preview is unavailable. Reopen the library.");
      const projects = new Set(
        intents.flatMap((intent) =>
          intent.kind === "install-external-skill" || intent.kind === "assign"
            ? intent.targets.map((target) => target.projectId)
            : [],
        ),
      );
      for (const projectId of projects)
        if (!(await canvas.onEnsureGrant({ kind: "project", id: projectId })))
          throw new Error(`Project ${projectId} is inaccessible. Reconnect it before installing.`);
      const next: SkillPreview[] = [];
      for (const intent of intents) next.push(parseSkillPreview(await canvas.api.previewSkillOperation({ intent })));
      if (ticket === generation.current) setReviewed({ key, previews: next });
    })()
      .catch((failure: unknown) => {
        if (ticket === generation.current)
          setError(failure instanceof Error ? failure.message : "External skill preview failed.");
      })
      .finally(() => {
        if (ticket === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [key, canvas.api, canvas.onEnsureGrant]);
  const ready =
    previews.length === intents.length &&
    previews.length > 0 &&
    previews.every((preview) => preview.status === "ready") &&
    !busy &&
    !results.length;
  async function apply(): Promise<void> {
    if (locked.current || !ready || !canvas.api?.applySkillOperation) return;
    locked.current = true;
    setBusy(true);
    setApplying(true);
    setError(null);
    onApplyingChange(true);
    try {
      for (const preview of previews) {
        if (preview.status !== "ready") throw new Error("The preview is unavailable. Review these changes again.");
        const result = parseSkillResult(
          await canvas.api.applySkillOperation({
            intentId: preview.intentId,
            effectFingerprint: preview.effectFingerprint,
          }),
        );
        setResults((current) => [...current, result]);
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "External skill operation failed. Open History to inspect applied changes.",
      );
    } finally {
      try {
        await onChanged();
        canvas.onRefresh();
      } catch {
        setError(
          "Changes completed, but the library could not be refreshed. Open History and check the library again.",
        );
      }
      // A failed apply must be previewed again; never replay the consumed plans.
      setReviewed({ key, previews: [] });
      setBusy(false);
      setApplying(false);
      locked.current = false;
      onApplyingChange(false);
    }
  }
  return { previews, results, busy, applying, error, ready, apply };
}
