import { expect, it } from "vitest";
import { t } from "../../src/renderer/i18n";
import { historyTitle, historyAttribution } from "../../src/renderer/canvas/rail/history-view-model";
import { isReceiptRestorable } from "../../src/renderer/review/CompletedOperations";
import type { OperationReceipt } from "../../src/shared/operations-ipc";
const english = ((key, values) => t(key, values ?? {}, "en")) as Parameters<typeof historyTitle>[1];
const child: OperationReceipt = {
  operationId: "child",
  kind: "update-external-skills",
  status: "applied",
  appliedAt: "2026-10-12T00:00:00.000Z",
  displayTarget: "External skills",
  actions: [],
  git: { mode: "disabled" },
  registered: null,
  project: { id: "project" },
  externalSkill: {
    kind: "update-external-skills",
    sourceId: "fixture/tools",
    projectId: "project",
    device: "1",
    inode: "1",
    backupPath: "omni/backups/external-skills/operation/child.json",
    backupHash: "a".repeat(64),
    direction: "forward",
    copies: 2,
    layouts: [{ path: ".agents/skills/demo", harnessId: "codex", afterHash: "a".repeat(64) }],
  },
};
it("names the external source and allows Undo from its saved receipt", () => {
  expect(historyTitle(child, english, "en")).toBe("Updated external skills from fixture/tools");
  expect(isReceiptRestorable(child, [child])).toBe(true);
  expect(isReceiptRestorable({ ...child, restored: true }, [child])).toBe(false);
  expect(
    historyAttribution({ ...child, provenance: { approval: "automatic", reason: "automatique" } }, [child], english),
  ).toContain("Automatic");
});
