import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../../src/renderer/i18n";
import { ResourceCanvas } from "../../../src/renderer/canvas/ResourceCanvas";
import type { SkillPreview, SkillResult } from "../../../src/shared/skill-management-ipc";
import type { WriteSkillRequest } from "../../../src/shared/operations-write-skill-ipc";
import { snapshot, resourceFixture } from "../resource-catalogue";
import { SheetReception } from "./sheet-view";
import { AdoptionReception } from "./adoption-view";
import { VariantReception } from "./variant-view";
import { ResolutionReception } from "./resolution-view";
import { UnboundResolutionReception } from "./unbound-view";
import "../../../src/renderer/theme/tokens.css";
import "../../../src/renderer/components/ui/ui.css";
import "../../../src/renderer/styles.css";

const file = {
  rootId: "source-one",
  relativePath: "plugins/pstack/skills/review/SKILL.md",
  change: "change" as const,
  beforeHash: "a".repeat(64),
  afterHash: "b".repeat(64),
  diff: "--- SKILL.md (current)\n+++ SKILL.md (proposed)\n@@ -1,6 +1,8 @@\n # Review with evidence\n \n-Review only SKILL.md.\n+Review the complete skill tree.\n+Include references and scripts in the comparison.\n \n Keep project changes separate.\n+Never overwrite local edits silently.\n Return the scoped receipt.\n",
};
const request: WriteSkillRequest = {
  kind: "write-skill",
  sourceId: "source-one",
  packageId: "pstack",
  mode: "update",
  folderName: "review",
  files: [{ path: "SKILL.md", content: "# Review with evidence\n" }],
};
const preview: SkillPreview = {
  status: "ready",
  intentId: "visual-intent",
  planId: "visual-plan",
  effectFingerprint: "c".repeat(64),
  scope: { sourceId: "source-one", packageId: "pstack", targets: [] },
  steps: [
    {
      stepId: "source",
      scope: { sourceId: "source-one", packageId: "pstack", targets: [] },
      files: [
        file,
        {
          rootId: "source-one",
          relativePath: "plugins/pstack/skills/review/references/checks.md",
          change: "add",
          afterHash: "d".repeat(64),
          diff: "@@ -0,0 +1,3 @@\n+# Checks\n+Verify the actual before state.\n+Preserve unrelated project changes.\n",
        },
      ],
      bindingEffects: [],
      plan: {
        planId: "visual-plan",
        kind: "write-skill",
        displayTarget: "pstack",
        actions: [],
        git: { mode: "unavailable", warnings: [] },
      },
    },
  ],
};
const result: SkillResult = {
  intentId: "visual-intent",
  operationId: "visual-intent",
  status: "applied",
  source: { status: "updated", sourceId: "source-one" },
  targets: [],
  receiptIds: ["source-receipt"],
  receipts: [
    {
      operationId: "source-receipt",
      kind: "write-skill",
      status: "applied",
      appliedAt: "2026-10-07T10:00:00.000Z",
      displayTarget: "pstack",
      actions: [],
      git: { mode: "unavailable" },
      registered: { sourceId: "source-one" },
    },
  ],
  issues: [],
  recoveryAvailable: false,
};
const mode = new URLSearchParams(location.search).get("mode");
const api = {
  previewSkillOperation: async () => preview,
  refreshSkillOperation: async () => preview,
  applySkillOperation: async (): Promise<SkillResult> => {
    throw new Error("This read-only visual fixture has no filesystem effects.");
  },
  readSkillOperationResult: async () =>
    mode === "recovery"
      ? {
          ...result,
          status: "recovery-required" as const,
          source: { status: "unknown" as const, sourceId: "source-one" },
          recoveryAvailable: true,
          issues: [
            {
              code: "interrupted",
              message: "The previous operation stopped before verification. Review recovery before continuing.",
              recoveryAction: "inspect-recovery" as const,
            },
          ],
        }
      : result,
  listSkillOperationRecoveries: async () => [],
};
createRoot(document.getElementById("root")!).render(
  <I18nProvider initialLanguage="en">
    <div className="app-shell app-shell--canvas">
      <div className="content-area content-area--canvas">
        {mode === "unbound" ? (
          <UnboundResolutionReception />
        ) : mode === "variant" ? (
          <VariantReception />
        ) : mode === "resolution" ? (
          <ResolutionReception />
        ) : mode === "adoption" ? (
          <AdoptionReception />
        ) : mode === "sheets" ? (
          <SheetReception />
        ) : (
          <ResourceCanvas
            context={{ kind: "entry", entry: resourceFixture.sourceRef }}
            snapshot={snapshot}
            api={api}
            initialSkillRequest={mode === "result" || mode === "recovery" || mode === "handoff" ? undefined : request}
            initialSkillResultId={mode === "result" || mode === "recovery" ? "visual-intent" : undefined}
            onEnsureGrant={async () => null}
            onNavigate={() => undefined}
            onRefresh={() => undefined}
            onNavigateDestination={() => undefined}
          />
        )}
      </div>
    </div>
  </I18nProvider>,
);
