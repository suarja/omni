import type { ReactElement } from "react";
import type { SkillPreview, SkillResult } from "../../../shared/skill-management-ipc";
import { useI18n } from "../../i18n";
import { ChangesDiff } from "../changes/ChangesDiff";
import { ChangesResult } from "../changes/ChangesResult";
import { useCanvasRail } from "../rail/rail-context";
import "../changes/changes.css";

export function OperationEvidence(
  props: Readonly<{
    previews: readonly SkillPreview[];
    results: readonly SkillResult[];
    error: string | null;
    busy: boolean;
  }>,
): ReactElement {
  const { t } = useI18n();
  const rail = useCanvasRail();
  const nameFor = (id: string): string =>
    rail?.canvas.snapshot.registry.projects.find((project) => project.ref.id === id)?.displayName ?? id;
  return (
    <>
      {props.busy ? <p role="status">{t("externalLibrary.previewHint")}</p> : null}
      {props.error ? (
        <p role="alert" className="external-error">
          {props.error}
        </p>
      ) : null}
      {props.previews.map((preview) =>
        preview.status === "ready" ? (
          <details key={preview.intentId} className="external-section">
            <summary>{t("externalLibrary.changes")}</summary>
            <ChangesDiff steps={preview.steps} nameFor={nameFor} t={t} />
          </details>
        ) : (
          <div key={preview.intentId} role="alert" className="external-callout is-warn">
            <div>
              <b>{preview.reason}</b>
              {preview.details.map((detail, index) => (
                <p key={index}>{detail.message}</p>
              ))}
            </div>
          </div>
        ),
      )}
      {props.results.map((result) => (
        <ChangesResult
          key={result.intentId}
          result={result}
          t={t}
          nameFor={nameFor}
          onRestore={(operationId) => {
            rail?.close();
            rail?.canvas.onNavigate({
              screen: "resource-canvas",
              context: { kind: "workspace" },
              initialSkillRestoreOperationId: operationId,
            });
          }}
        />
      ))}
    </>
  );
}
