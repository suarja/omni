import { expect, it } from "vitest";
import { t } from "../../src/renderer/i18n";
import {
  historyTitle,
  historyTime,
  historyDay,
  historyAttribution,
  historyLocation,
} from "../../src/renderer/canvas/rail/history-view-model";
import type { OperationReceipt } from "../../src/shared/operations-ipc";

const translate = (key: Parameters<typeof t>[0], values?: Parameters<typeof t>[1]): string =>
  t(key, values ?? {}, "fr");
const receipt: OperationReceipt = {
  operationId: "receipt",
  kind: "write-skill",
  status: "applied",
  appliedAt: "2026-10-11T18:50:00",
  displayTarget: "My marketplace",
  registered: null,
  git: { mode: "disabled" },
  actions: [{ kind: "write-file", status: "applied", relativePath: "plugins/release/skills/mobile-release/SKILL.md" }],
};

it("names a marketplace addition from the actual skill files", () => {
  expect(historyTitle(receipt, translate, "fr")).toBe("Ajout de mobile-release à la marketplace");
});
it("translates the bridge receipt without changing its stored title", () => {
  expect(
    historyTitle(
      { ...receipt, kind: "bridge-skill-uses", actions: [], displayTarget: "Omni now tracks 70 copies" },
      translate,
      "fr",
    ),
  ).toBe("Omni suit maintenant 70 copies");
});

it("names the updated skill and registered project instead of a technical target", () => {
  expect(
    historyTitle(
      {
        ...receipt,
        kind: "apply-plan",
        source: { kind: "source", id: "source", relativePath: "skills/codex" },
        project: { id: "notes-app" },
      },
      translate,
      "fr",
    ),
  ).toBe("Mise à jour de codex dans notes-app");
});

it("attributes an agent request and its recorded approval once", () => {
  const agentReceipt = {
    ...receipt,
    provenance: {
      agent: { harness: "claude-code" as const, requestedAt: receipt.appliedAt },
      approval: "conversation" as const,
    },
  };
  expect(historyAttribution(agentReceipt, [], translate)).toBe("demandé par Claude Code · validé dans la conversation");
  expect(historyAttribution(receipt, [], translate)).toBe("demandé depuis Omni");
});

it("does not invent approval when an older agent receipt has no approval evidence", () => {
  const agentReceipt = {
    ...receipt,
    provenance: { agent: { harness: "codex" as const, requestedAt: receipt.appliedAt } },
  };
  expect(historyAttribution(agentReceipt, [], translate)).toBe("demandé par Codex · validation non enregistrée");
});

it("uses calendar days for today and yesterday across midnight", () => {
  const now = new Date(2026, 9, 11, 0, 5);
  const today = new Date(2026, 9, 11, 0, 1).toISOString();
  const yesterday = new Date(2026, 9, 10, 22, 26).toISOString();
  const earlier = new Date(2026, 9, 9, 18, 50).toISOString();
  expect(historyDay(today, translate, "fr", now)).toBe("Aujourd'hui");
  expect(historyDay(yesterday, translate, "fr", now)).toBe("Hier");
  expect(historyDay(earlier, translate, "fr", now)).toBe("09/10/2026");
  expect(historyTime(today, translate, "fr")).toBe("00:01");
  expect(historyTime(yesterday, translate, "fr")).toBe("22:26");
  expect(historyTime(earlier, translate, "fr")).toBe("18:50");
  expect(historyDay("unknown", translate, "fr", now)).toBe("Date indisponible");
  expect(historyTime("unknown", translate, "fr")).toBe("Date indisponible");
});

it("names a grouped operation from its child receipt rather than its internal package target", () => {
  const summary = {
    ...receipt,
    operationId: "group",
    kind: "skill-management" as const,
    displayTarget: "pstack",
    children: [receipt.operationId],
    actions: [],
  };
  expect(historyTitle(summary, translate, "fr", undefined, [receipt])).toBe("Ajout de mobile-release à la marketplace");
});

it("calls a restored grouped operation an undo instead of an update", () => {
  expect(historyTitle({ ...receipt, kind: "skill-management", restores: "original" }, translate, "fr")).toBe(
    "Annulation des changements dans mobile-release",
  );
});

it.each(["fr", "en"] as const)("groups history targets and preserves agent names in %s", (language) => {
  const targets: NonNullable<OperationReceipt["skillManagement"]>["targets"] = ["acme-web", "notes-app"].flatMap(
    (projectId) =>
      (["claude-code", "codex"] as const).map((harnessId) => ({
        projectId,
        harnessId,
        bindingId: `${projectId}-${harnessId}`,
        artifactPath: "skills/review",
        status: "applied" as const,
      })),
  );
  const grouped: OperationReceipt = {
    ...receipt,
    skillManagement: {
      intentId: "intent",
      operationId: receipt.operationId,
      status: "applied",
      source: { status: "unchanged" },
      targets,
      receiptIds: [],
      issues: [],
      recoveryAvailable: false,
    },
  };
  const translate = (key: Parameters<typeof t>[0], values?: Parameters<typeof t>[1]): string =>
    t(key, values ?? {}, language);
  const location = historyLocation(
    grouped,
    { registry: { revision: 1, projects: [], sources: [] }, roots: [], uses: { status: "ready", bindings: [] } },
    language,
  );
  expect(`${location} · ${historyAttribution(grouped, [], translate)}`).toBe(
    language === "fr"
      ? "acme-web et notes-app · Claude Code et Codex · demandé depuis Omni"
      : "acme-web and notes-app · Claude Code and Codex · requested from Omni",
  );
});
