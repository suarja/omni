import { useState, type ReactElement } from "react";

import type { ResourceContext } from "../../../src/domain/resource-catalogue";
import type { ReadArtifactRequest, ReadArtifactResponse } from "../../../src/shared/artifact-ipc";
import type { ResourceCanvasProps } from "../../../src/renderer/canvas/ResourceCanvas";
import { ResourceCanvas } from "../../../src/renderer/canvas/ResourceCanvas";
import type { WorkspaceSetupInputs } from "../../../src/renderer/canvas/setup/workspace-setup-types";
import { snapshot, resourceFixture } from "../resource-catalogue";

const documentContent = [
  "---",
  "name: review",
  "description: Review source with evidence.",
  "version: 1.0.0",
  "---",
  "# Review with evidence",
  "",
  "Inspect the complete skill tree before proposing changes.",
  "",
  "## Scope",
  "",
  "Keep `SKILL.md` and its support files together.",
  "",
  "> Preserve unrelated project changes and record the result.",
  "",
  "- Read source metadata",
  "- Compare the local copies",
  "- Review the proposed effects",
  "",
  "### Example",
  "",
  "```json",
  '{ "scope": "project", "operation": "review" }',
  "```",
  "",
  "| Resource | Role |",
  "| --- | --- |",
  "| Skill | Instructions |",
  "| References | Evidence |",
  "",
  "## Verification",
  "",
  "Verify the current files before applying a change.",
  "",
  "A_long_identifier_to_check_wrapping_in_the_document_reader_without_horizontal_page_overflow.",
  "",
  ...Array.from({ length: 6 }, () => "Additional evidence stays in the scrollable reader.\n"),
].join("\n");

async function readArtifact(request: ReadArtifactRequest): Promise<ReadArtifactResponse> {
  const content = request.relativePath.endsWith(".json")
    ? '{\n  "name": "pstack",\n  "version": "1.0.0"\n}\n'
    : documentContent;
  return { status: "read", content, byteLength: new TextEncoder().encode(content).length, truncated: false };
}

async function rejectWrite(): Promise<never> {
  throw new Error("This read-only sheet fixture has no filesystem effects.");
}

const api: NonNullable<ResourceCanvasProps["api"]> = {
  readArtifact,
  previewSkillOperation: rejectWrite,
  refreshSkillOperation: rejectWrite,
  applySkillOperation: rejectWrite,
  readSkillOperationResult: rejectWrite,
  listSkillOperationRecoveries: async () => [],
};
const setup: WorkspaceSetupInputs = {
  snapshot,
  api: {
    pickOperationParent: rejectWrite,
    previewOperation: rejectWrite,
    applyOperation: rejectWrite,
    getAgentStatus: async () => ({
      socketPath: "fixture-socket",
      tokenCreatedAt: "2026-10-08T08:00:00.000Z",
      counts: { pending: 0, today: 0, total: 0 },
      harnesses: (["codex", "claude-code"] as const).map((harness) => ({
        harness,
        detected: true,
        registered: false,
        current: false,
        guard: false,
        settingsPath: "fixture-settings",
        skillsPath: "fixture-skills",
        skills: [],
      })),
    }),
  },
  commands: {
    registerProject: async () => ({ status: "cancelled" }),
    registerSource: async () => ({ status: "cancelled" }),
    refreshRegistry: async () => ({ status: "ready", registry: snapshot.registry }),
    observeEntry: async () => undefined,
  },
  registryBusy: false,
  diagnostic: null,
};

export function SheetReception(): ReactElement {
  const [context, setContext] = useState<ResourceContext>(() =>
    new URLSearchParams(location.search).get("view") === "project"
      ? { kind: "entry", entry: resourceFixture.projectOneRef }
      : { kind: "workspace" },
  );
  return (
    <ResourceCanvas
      context={context}
      snapshot={snapshot}
      api={api}
      setup={setup}
      onEnsureGrant={async () => "fixture-read-grant"}
      onNavigate={(route) => {
        if (route.screen === "resource-canvas") setContext(route.context);
      }}
      onRefresh={() => undefined}
      onNavigateDestination={() => undefined}
    />
  );
}
