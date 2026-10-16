import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ResourceRecord } from "../../domain/resource-catalogue";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { useI18n, tCount } from "../i18n";
import { SheetFrame } from "./SheetFrame";

export function MissingProjectsSheet(
  props: Readonly<{
    projects: readonly ResourceRecord[];
    canvas: ResourceCanvasProps;
    onClose: () => void;
    onApplyingChange?: (active: boolean) => void;
  }>,
): ReactElement {
  const { language, t } = useI18n();
  const [remaining, setRemaining] = useState(props.projects);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(props.canvas.snapshot.registry.revision);
  const locked = useRef(false);
  useEffect(() => {
    props.onApplyingChange?.(busy);
    return () => props.onApplyingChange?.(false);
  }, [busy, props.onApplyingChange]);
  async function archive(): Promise<void> {
    const command = props.canvas.api?.archiveEntry;
    if (!command || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    let left = [...remaining];
    try {
      for (const project of remaining) {
        const result = await command({ ...project.ref.entry, expectedRevision: revision.current });
        if (result.status !== "ready")
          throw new Error(
            result.status === "revision-conflict" || result.status === "workshop-conflict"
              ? t("projectView.registryConflict")
              : result.diagnostic,
          );
        revision.current = result.registry.revision;
        left = left.filter((item) => item.ref.entry.id !== project.ref.entry.id);
        setRemaining(left);
      }
      props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("projectView.operationFailed"));
    } finally {
      props.canvas.onRefresh();
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <SheetFrame
      title={tCount("projectView.missingFolders", remaining.length, {}, language)}
      kicker={t("canvas.workspace")}
      testId="missing-projects-sheet"
      busy={busy}
      onClose={() => {
        if (!locked.current) props.onClose();
      }}
      footer={
        <button
          type="button"
          className="canvas-secondary-button is-primary"
          disabled={busy || !props.canvas.api?.archiveEntry || !remaining.length}
          onClick={() => void archive()}
        >
          {t("projectView.removeFromWorkspace")}
        </button>
      }
    >
      <p>{t("projectView.archiveMissingCopy")}</p>
      <ul>
        {remaining.map((project) => (
          <li key={project.ref.entry.id}>{project.label}</li>
        ))}
      </ul>
      {error ? <p role="alert">{error}</p> : null}
    </SheetFrame>
  );
}
