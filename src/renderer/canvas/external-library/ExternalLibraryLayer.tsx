import { CopySourceSheet } from "./CopySourceSheet";
import { RemovedUseSheet } from "./RemovedUseSheet";
import type { ReactElement } from "react";
import { useCanvasRail } from "../rail/rail-context";
import { ExternalSkillSheet } from "../pages/ExternalSkillSheet";
import { resolveExternalSkill } from "../pages/external-skill-selection";

import { CompareListSheet } from "./CompareListSheet";
import { UpdateSheet } from "./UpdateSheet";
import { InstallSheet } from "./InstallSheet";

export function ExternalLibraryLayer(
  props: Readonly<{ onApplyingChange: (busy: boolean) => void }>,
): ReactElement | null {
  const rail = useCanvasRail();
  if (!rail || rail.surface !== "external-library") return null;
  const selection = rail.externalSelection;
  if (selection.sourceId && selection.view === "copy" && selection.skillName) {
    const { removed } = resolveExternalSkill(rail.externalLibrary.details.get(selection.sourceId), {
      ...selection,
      skillName: selection.skillName,
    });
    if (removed) return <RemovedUseSheet use={removed} initialCopy onApplyingChange={props.onApplyingChange} />;
    return (
      <CopySourceSheet
        key={JSON.stringify([selection.sourceId, selection.skillName, selection.skillPath, selection.useId])}
        sourceId={selection.sourceId}
        skillName={selection.skillName}
        skillPath={selection.skillPath}
        useId={selection.useId}
        onApplyingChange={props.onApplyingChange}
      />
    );
  }
  if (selection.sourceId && selection.view === "install" && selection.skillName)
    return (
      <InstallSheet
        key={JSON.stringify([selection.sourceId, selection.skillName, selection.skillPath, selection.useId])}
        sourceId={selection.sourceId}
        skillName={selection.skillName}
        skillPath={selection.skillPath}
        useId={selection.useId}
        initialProjectIds={selection.projectIds}
        onApplyingChange={props.onApplyingChange}
      />
    );
  if (selection.sourceId && selection.view === "compare") {
    const liveUse = rail.externalLibrary.details
      .get(selection.sourceId)
      ?.uses.find((use) => use.id === selection.useId);
    const use = liveUse?.state === "removed" ? liveUse : rail.selectedRemovedUse;
    if (use?.state === "removed")
      return <RemovedUseSheet key={use.id} use={use} onApplyingChange={props.onApplyingChange} />;
    if (selection.skillName)
      return (
        <UpdateSheet
          key={JSON.stringify([selection.sourceId, selection.skillName, selection.skillPath, selection.useId])}
          sourceId={selection.sourceId}
          skillName={selection.skillName}
          skillPath={selection.skillPath}
          useId={selection.useId}
          onApplyingChange={props.onApplyingChange}
        />
      );
    return <CompareListSheet sourceId={selection.sourceId} />;
  }
  if (selection.sourceId && selection.skillName)
    return (
      <ExternalSkillSheet
        key={JSON.stringify([selection.sourceId, selection.skillName, selection.skillPath, selection.useId])}
        sourceId={selection.sourceId}
        skillName={selection.skillName}
        skillPath={selection.skillPath}
        useId={selection.useId}
      />
    );
  return null;
}
