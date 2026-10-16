import type { ReactElement } from "react";
import { ResourceCanvas } from "../../../src/renderer/canvas/ResourceCanvas";
import {
  parseSkillIntent,
  parseSkillPreview,
  parseSkillResult,
  type SkillPreview,
} from "../../../src/shared/skill-management-ipc";
import { snapshot, resourceFixture } from "../resource-catalogue";
import inputs from "./adoption-inputs.json";

/** Production components with recorded disposable receipts; this fixture cannot write. */
export function AdoptionReception(): ReactElement {
  const state = new URLSearchParams(location.search).get("state") ?? "adoption";
  const recorded = state === "restore" || state === "restored" ? inputs.restore : inputs.adoption;
  const input: typeof recorded =
    state === "long-path"
      ? JSON.parse(
          JSON.stringify(recorded)
            .replaceAll("packages/tools", `packages/${"long-source-package".repeat(10)}`)
            .replaceAll(
              inputs.adoption.intent.request.source.artifactPath,
              `skills/${"long-artifact-segment".repeat(4)}`,
            ),
        )
      : recorded;
  const ready = parseSkillPreview(input.preview);
  const reason = "Every selected copy must match the complete source tree, including support files.";
  const preview: SkillPreview =
    state === "withheld"
      ? {
          status: "needs-input",
          intentId: ready.intentId,
          reason,
          details: [{ code: "unequal-copy", message: reason, recoveryAction: "refresh" }],
        }
      : ready;
  const result = parseSkillResult(input.result);
  const api = {
    previewSkillOperation: async () => preview,
    refreshSkillOperation: async () => preview,
    applySkillOperation: async (): Promise<never> => {
      throw new Error("Read-only visual reception cannot apply operations.");
    },
    readSkillOperationResult: async () => result,
    listSkillOperationRecoveries: async () => [],
  };
  return (
    <ResourceCanvas
      context={{ kind: "entry", entry: resourceFixture.sourceRef }}
      snapshot={snapshot}
      api={api}
      initialSkillIntent={parseSkillIntent(input.intent)}
      initialSkillResultId={state === "applied" || state === "restored" ? result.intentId : undefined}
      onEnsureGrant={async () => null}
      onNavigate={() => undefined}
      onRefresh={() => undefined}
      onNavigateDestination={() => undefined}
    />
  );
}
