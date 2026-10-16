import type { ReactElement } from "react";
import { ResourceCanvas } from "../../../src/renderer/canvas/ResourceCanvas";
import { OperationChangesWorkbench } from "../../../src/renderer/canvas/changes/OperationChangesWorkbench";
import { parseSkillIntent, parseSkillPreview, parseSkillResult } from "../../../src/shared/skill-management-ipc";
import { snapshot, resourceFixture } from "../resource-catalogue";
import inputs from "./resolution-inputs.json";

/** Recorded real coordinator effects; the browser adapter rejects every apply. */
export function ResolutionReception(): ReactElement {
  const state = new URLSearchParams(location.search).get("state") ?? "choice";
  const recorded =
    state === "restore" || state === "restored"
      ? inputs.restore
      : state === "retained"
        ? inputs.keep
        : inputs.canonical;
  const intent = parseSkillIntent(recorded.intent);
  const result = parseSkillResult(recorded.result);
  const canonicalIntent = parseSkillIntent(inputs.canonical.intent);
  if (canonicalIntent.kind !== "reconcile" || canonicalIntent.request.choice === "adopt-exact")
    throw new Error("Recorded managed selection is unavailable.");
  const api = {
    previewSkillOperation: async (request: { intent: typeof intent }) => {
      const input =
        request.intent.kind === "reconcile" && request.intent.request.choice === "keep-local" ? inputs.keep : recorded;
      return parseSkillPreview(input.preview);
    },
    refreshSkillOperation: async () => parseSkillPreview(recorded.preview),
    applySkillOperation: async (): Promise<never> => {
      throw new Error("Read-only visual reception cannot apply.");
    },
    readSkillOperationResult: async () => result,
    listSkillOperationRecoveries: async () => [],
  };
  if (state === "choice")
    return (
      <div className="resource-canvas">
        <OperationChangesWorkbench
          api={api}
          initialJourney="assign"
          initialManagedResolution={{
            skillId: canonicalIntent.request.skillId,
            location: canonicalIntent.request.locations[0],
          }}
          sources={[
            { id: canonicalIntent.request.locations[0].projectId, name: "Disposable project" },
            { id: inputs.canonical.preview.scope.sourceId, name: "Personal" },
          ]}
          packages={[]}
          projects={[]}
          artifacts={[]}
          onClose={() => undefined}
          onSourceChanged={() => undefined}
        />
      </div>
    );
  return (
    <ResourceCanvas
      context={{ kind: "entry", entry: resourceFixture.sourceRef }}
      snapshot={snapshot}
      api={api}
      initialSkillIntent={intent}
      initialSkillResultId={
        state === "applied" || state === "restored" || state === "retained" ? result.intentId : undefined
      }
      onEnsureGrant={async () => null}
      onNavigate={() => undefined}
      onRefresh={() => undefined}
      onNavigateDestination={() => undefined}
    />
  );
}
