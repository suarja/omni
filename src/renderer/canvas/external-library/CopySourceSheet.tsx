import { useOptionalCanvasToast } from "../CanvasToast";
import { useI18n } from "../../i18n";
import { useMemo, type ReactElement } from "react";
import { useCanvasRail } from "../rail/rail-context";
import { ProjectCaptureSheet } from "../ProjectCaptureSheet";
import type { ProjectSkillRow } from "../../../shared/project-skills-ipc";
import { resolveExternalSkill, type ExternalSkillTarget } from "../pages/external-skill-selection";

export function CopySourceSheet(
  props: Readonly<{ sourceId: string; onApplyingChange: (busy: boolean) => void }> & ExternalSkillTarget,
): ReactElement | null {
  const rail = useCanvasRail();
  const toast = useOptionalCanvasToast();
  const { t } = useI18n();
  const details = rail?.externalLibrary.details.get(props.sourceId);
  const { skill } = resolveExternalSkill(details, props);
  const selection = useMemo(
    () => ({ sourceId: props.sourceId, skillPath: skill?.path ?? "" }),
    [props.sourceId, skill?.path],
  );
  if (!rail || !skill) return null;
  const row: ProjectSkillRow = {
    id: "external-copy",
    name: skill.name,
    description: skill.description,
    origin: { kind: "external", source: details?.source?.name ?? props.sourceId },
    state: "current",
    agents: { codex: { state: "absent" }, "claude-code": { state: "absent" } },
  };
  return (
    <ProjectCaptureSheet
      canvas={rail.canvas}
      projectId="external-copy"
      projectName={details?.source?.name ?? props.sourceId}
      row={row}
      externalSource={selection}
      onClose={() =>
        rail.openExternalContext({
          sourceId: props.sourceId,
          skillName: props.skillName,
          skillPath: skill.path,
          useId: props.useId,
          view: "skill",
        })
      }
      onApplyingChange={props.onApplyingChange}
      onApplied={(receipt, message) => {
        toast?.show({
          message,
          ...(receipt.status === "applied"
            ? { action: { label: t("externalLibrary.history"), run: () => rail.open("activity") } }
            : {}),
        });
        rail.canvas.onRefresh();
        void rail.externalLibrary.reload();
      }}
    />
  );
}
