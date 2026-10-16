import { readProjectSkills } from "../read-project-skills";
import { useEffect, useState, type ReactElement } from "react";
import type { ExternalUse } from "../../../shared/external-library-ipc";
import { type ProjectSkillRow } from "../../../shared/project-skills-ipc";
import type { SkillIntent } from "../../../shared/skill-management-ipc";
import { useCanvasRail } from "../rail/rail-context";
import { useI18n } from "../../i18n";
import { SheetFrame } from "../SheetFrame";
import { SkillCallouts } from "./SkillCallouts";
import { ProjectCaptureSheet } from "../ProjectCaptureSheet";
import { useExternalOperation } from "./use-external-operation";
import { OperationEvidence } from "./OperationEvidence";

export function RemovedUseSheet(
  props: Readonly<{ use: ExternalUse; onApplyingChange: (busy: boolean) => void; initialCopy?: boolean }>,
): ReactElement | null {
  const rail = useCanvasRail();
  const { t } = useI18n();
  const [row, setRow] = useState<ProjectSkillRow | null>(null);
  const [copy, setCopy] = useState(Boolean(props.initialCopy));
  const [error, setError] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const [remove, setRemove] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!rail) throw new Error("This project is inaccessible. Reopen the library to manage the removed copy.");
      const data = await readProjectSkills(rail.canvas, props.use.projectId);
      const selected = data.skills.find(
        (item) =>
          item.name === props.use.skillKey &&
          item.origin.kind === "external" &&
          item.origin.source.toLowerCase() === props.use.sourceId.toLowerCase(),
      );
      if (!selected) throw new Error("The external copy was not found. Read the project again.");
      if (active) setRow(selected);
    })().catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : "The removed copy could not be read.");
    });
    return () => {
      active = false;
    };
  }, [rail?.canvas.api, props.use.id]);
  const intents: SkillIntent[] =
    remove && row ? [{ kind: "project-skill", projectId: props.use.projectId, rowId: row.id, action: "delete" }] : [];
  const operation = useExternalOperation(rail!.canvas, intents, props.onApplyingChange, rail!.externalLibrary.reload);
  if (!rail) return null;
  async function keep(): Promise<void> {
    if (keeping || !rail?.canvas.api?.acknowledgeRemovedExternalUse) return;
    setKeeping(true);
    try {
      await rail.canvas.api.acknowledgeRemovedExternalUse({ useId: props.use.id });
      await rail.externalLibrary.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The removed copy could not be acknowledged.");
    } finally {
      setKeeping(false);
    }
  }
  if (copy && row)
    return (
      <ProjectCaptureSheet
        canvas={rail.canvas}
        row={row}
        selectedFolder={props.use.folderPath}
        projectId={props.use.projectId}
        projectName={props.use.projectName}
        onClose={() => setCopy(false)}
        onApplyingChange={props.onApplyingChange}
        onApplied={() => {
          void rail.externalLibrary.reload();
          rail.canvas.onRefresh();
          setCopy(false);
        }}
      />
    );
  return (
    <SheetFrame
      title={props.use.skillKey}
      subtitle={props.use.projectName}
      kicker={t("externalLibrary.removed")}
      testId="external-removed-sheet"
      className="external-library-sheet"
      busy={operation.applying || keeping}
      onClose={rail.close}
      footer={
        <>
          <button
            type="button"
            className="canvas-secondary-button"
            disabled={keeping || props.use.acknowledged || !rail.canvas.api?.acknowledgeRemovedExternalUse}
            onClick={() => void keep()}
          >
            {t("externalLibrary.keep")}
          </button>
          <span className="skill-footer-note" />
          <button
            type="button"
            className="canvas-secondary-button is-danger"
            disabled={!row || operation.applying}
            onClick={() => setRemove(true)}
          >
            {t("externalLibrary.remove")}
          </button>
          {remove ? (
            <button
              type="button"
              className="canvas-secondary-button is-primary"
              disabled={!operation.ready}
              onClick={() => void operation.apply()}
            >
              {t("projectView.deleteAction")}
            </button>
          ) : null}
        </>
      }
    >
      <SkillCallouts use={props.use} busy={!row || keeping || operation.applying} onCapture={() => setCopy(true)} />
      <div className="external-callout is-read-only">
        <div>
          <b>{t("externalLibrary.published", { source: props.use.sourceId })}</b>
          <p>{t("externalLibrary.publishedHint")}</p>
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <OperationEvidence {...operation} />
    </SheetFrame>
  );
}
