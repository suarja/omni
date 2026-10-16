import type { ReactElement } from "react";
import { OperationChangesWorkbench } from "../../../src/renderer/canvas/changes/OperationChangesWorkbench";
import { parseSkillIntent, parseSkillPreview, parseSkillResult } from "../../../src/shared/skill-management-ipc";
import inputs from "./variant-inputs.json";

/** Real coordinator records displayed through production components without write authority. */
export function VariantReception(): ReactElement {
  const state = new URLSearchParams(location.search).get("state") ?? "diff";
  const recorded = state === "restore" || state === "restored" ? inputs.restore : inputs.capture;
  const intent = parseSkillIntent(recorded.intent);
  const result = parseSkillResult(recorded.result);
  const capture = parseSkillIntent(inputs.capture.intent);
  if (capture.kind !== "reconcile" || capture.request.choice !== "keep-variant")
    throw new Error("Capture fixture unavailable.");
  const api = {
    previewSkillOperation: async () => parseSkillPreview(recorded.preview),
    refreshSkillOperation: async () => parseSkillPreview(recorded.preview),
    applySkillOperation: async (): Promise<never> => {
      throw new Error("Read-only reception cannot apply.");
    },
    readSkillOperationResult: async () => result,
    listSkillOperationRecoveries: async () => [],
  };
  return (
    <div className="resource-canvas">
      <OperationChangesWorkbench
        api={api}
        initialJourney="draft"
        initialSkillIntent={state === "choice" ? undefined : intent}
        initialManagedResolution={
          state === "choice" ? { skillId: capture.request.skillId, location: capture.request.locations[0] } : undefined
        }
        initialResultId={state === "applied" || state === "restored" ? result.intentId : undefined}
        sources={[
          { id: capture.request.destination.sourceId, name: "Personal" },
          { id: capture.request.locations[0].projectId, name: "Disposable project" },
        ]}
        variantDestinations={[
          {
            sourceId: capture.request.destination.sourceId,
            sourceName: "Personal",
            packageId: capture.request.destination.packageId,
            packageName: "Tools",
          },
        ]}
        packages={[]}
        projects={[]}
        artifacts={[]}
        onClose={() => undefined}
        onSourceChanged={() => undefined}
        onOpenVariant={async () => {
          throw new Error("The read-only bench cannot navigate a native source.");
        }}
      />
    </div>
  );
}
