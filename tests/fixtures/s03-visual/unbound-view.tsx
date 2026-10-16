import type { ReactElement } from "react";

import { OperationChangesWorkbench } from "../../../src/renderer/canvas/changes/OperationChangesWorkbench";
import { parseSkillIntent, parseSkillPreview, parseSkillResult } from "../../../src/shared/skill-management-ipc";
import inputs from "./unbound-inputs.json";

/** Recorded real coordinator effects. Every component-bench write is rejected. */
export function UnboundResolutionReception(): ReactElement {
  const state = new URLSearchParams(location.search).get("state") ?? "diff";
  const recorded = state.startsWith("restore") ? inputs.restore : inputs;
  const intent = parseSkillIntent(recorded.intent);
  const preview = parseSkillPreview(recorded.preview);
  const result = parseSkillResult(recorded.result);
  const api = {
    previewSkillOperation: async () => preview,
    refreshSkillOperation: async () => preview,
    applySkillOperation: async (): Promise<never> => {
      throw new Error("Read-only visual reception cannot apply filesystem effects.");
    },
    readSkillOperationResult: async () => result,
    listSkillOperationRecoveries: async () => [],
  };
  if (intent.kind !== "restore" && (intent.kind !== "reconcile" || intent.request.choice !== "link-canonical"))
    throw new Error("Recorded canonical-link intent is unavailable.");
  if (preview.status !== "ready" || !result.link) throw new Error("Recorded canonical-link results are unavailable.");

  return (
    <div className="resource-canvas">
      <OperationChangesWorkbench
        api={api}
        artifacts={[]}
        initialJourney="draft"
        initialSkillIntent={state.endsWith("result") ? undefined : intent}
        initialResultId={state.endsWith("result") ? result.intentId : undefined}
        onAdoptionChanged={async () => undefined}
        onBack={() => undefined}
        onClose={() => undefined}
        onSourceChanged={() => undefined}
        packages={[]}
        projects={[
          {
            id: result.link.location.projectId,
            name: "Disposable project",
            available: true,
            harnesses: [result.link.location.harnessId],
          },
        ]}
        sources={[{ id: result.link.source.sourceId, name: "Personal" }]}
      />
    </div>
  );
}
