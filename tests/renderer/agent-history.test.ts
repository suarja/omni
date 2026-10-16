import { expect, it } from "vitest";
import { t } from "../../src/renderer/i18n";
import { historyTitle, historyLocation, historyAttribution } from "../../src/renderer/canvas/rail/history-view-model";
import type { OperationReceipt } from "../../src/shared/operations-ipc";
import { projectSnapshot } from "./project-view-fixture";
const translate = (key: Parameters<typeof t>[0], values?: Parameters<typeof t>[1]): string =>
  t(key, values ?? {}, "fr");
const receipt: OperationReceipt = {
  operationId: "agent-original",
  kind: "install-agents",
  status: "applied",
  appliedAt: "2026-10-12T09:00:00Z",
  displayTarget: "~/.codex/config.toml · ~/.codex/skills",
  registered: null,
  git: { mode: "not-a-repository" },
  actions: [{ kind: "write-file", relativePath: ".codex/skills/omni-bootstrap/SKILL.md", status: "applied" }],
};
it.each([
  ["disconnect", "Retrait d’Omni pour Codex", "Annulation : retrait d’Omni pour Codex"],
  ["connect", "Configuration d’Omni pour Codex", "Annulation : configuration d’Omni pour Codex"],
  ["reinstall", "Omni réinstallé dans Codex", "Annulation : Omni réinstallé dans Codex"],
  ["update", "Omni mis à jour pour Codex", "Annulation : Omni mis à jour pour Codex"],
] as const)("names %s Undo after the original agent operation", (action, title, undoTitle) => {
  const original: OperationReceipt = {
    ...receipt,
    kind: action === "disconnect" ? "disconnect-agents" : "install-agents",
    agentSetup: { action, harnesses: ["codex"] },
  };
  const undo: OperationReceipt = {
    ...receipt,
    operationId: "agent-undo",
    kind: "restore-import",
    restores: original.operationId,
  };
  expect(historyTitle(original, translate, "fr", projectSnapshot, [undo, original])).toBe(title);
  expect(historyTitle(undo, translate, "fr", projectSnapshot, [undo, original])).toBe(undoTitle);
  expect(
    historyLocation(undo, projectSnapshot, "fr", [undo, original]) +
      " · " +
      historyAttribution(undo, [undo, original], translate),
  ).toBe("Codex · demandé depuis Omni");
});
it("names the agent instead of settings paths on legacy configuration receipts and their Undo", () => {
  const undo = { ...receipt, operationId: "undo", kind: "restore-import" as const, restores: receipt.operationId };
  expect(historyLocation(receipt, projectSnapshot, "fr") + " · " + historyAttribution(receipt, [], translate)).toBe(
    "Codex · demandé depuis Omni",
  );
  expect(historyTitle(undo, translate, "fr", projectSnapshot, [undo, receipt])).toBe(
    "Annulation : configuration d’Omni pour Codex",
  );
  expect(historyLocation({ ...receipt, actions: [] }, projectSnapshot, "fr")).toBe("Codex");
});
it("keeps both agents on the grouped automatic update Undo", () => {
  const original: OperationReceipt = {
    ...receipt,
    agentSetup: { action: "update", harnesses: ["claude-code", "codex"], version: "1.2.3" },
    provenance: { approval: "automatic" },
  };
  const undo: OperationReceipt = { ...receipt, kind: "restore-import", restores: original.operationId };
  expect(historyTitle(undo, translate, "fr", projectSnapshot, [original])).toBe(
    "Annulation : Omni mis à jour pour Claude Code et Codex",
  );
  expect(
    historyLocation(undo, projectSnapshot, "fr", [original]) + " · " + historyAttribution(undo, [original], translate),
  ).toBe("Claude Code et Codex · demandé depuis Omni");
});
