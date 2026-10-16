import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { externalOperationFixture, setUpdates } from "../helpers/external-operations-fixture";
import { commit, git, write } from "../helpers/publication-fixture";
import { createExternalLibraryService } from "../../src/main/external-library/service";
import { createOperationStore } from "../../src/main/operation-store";
import { isReceiptRestorable } from "../../src/renderer/review/CompletedOperations";
import { historyTitle, historyAttribution } from "../../src/renderer/canvas/rail/history-view-model";
import { t } from "../../src/renderer/i18n";
import {
  createExternalAutomaticFailures,
  skipsAutomaticFailure,
} from "../../src/main/external-library/automatic-failures";
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused" },
  dialog: {},
  ipcMain: { handle: vi.fn() },
}));
const english = ((key, values) => t(key, values ?? {}, "en")) as Parameters<typeof historyTitle>[1];

it("suppresses only the failed use, head and copy hash while retaining the last reason", async () => {
  const f = await externalOperationFixture();
  const store = createExternalAutomaticFailures(f.data);
  const observation = await f.library.operationObservation();
  const source = observation.sources.find((source) => source.source?.id === "fixture/tools")!;
  const use = source.uses.find((use) => use.skillKey === "update")!;
  const head = source.source!.head!.commit;
  const failure = {
    sourceHead: head,
    copyHash: use.copyHash!,
    failedAt: "2026-10-12T12:00:00.000Z",
    reason: "Writer refused target.",
  };
  await store.record([{ useId: use.id, failure }]);
  const overlay = await createExternalAutomaticFailures(f.data).overlay(observation);
  const uses = overlay.sources.flatMap((source) => source.uses);
  const failed = uses.find((entry) => entry.id === use.id)!;
  expect(failed.lastAutomaticFailure).toEqual(failure);
  expect(uses.filter((entry) => entry.lastAutomaticFailure)).toHaveLength(1);
  expect(skipsAutomaticFailure(failed, head)).toBe(true);
  expect(skipsAutomaticFailure(failed, "f".repeat(40))).toBe(false);
  expect(skipsAutomaticFailure({ ...failed, copyHash: "f".repeat(64) }, head)).toBe(false);
  const other = {
    ...observation,
    sources: observation.sources.map((source) => ({
      ...source,
      uses: source.uses.map((entry) => (entry.id === use.id ? { ...entry, id: "changed-use" } : entry)),
    })),
  };
  expect(
    (await store.overlay(other)).sources.flatMap((source) => source.uses).some((entry) => entry.lastAutomaticFailure),
  ).toBe(false);
});

it("records an automatic failure once, exposes it after restart and retries a new source head", async () => {
  let attempts = 0;
  let fail = true;
  const f = await externalOperationFixture({
    fileWriter: async (path, value, options) => {
      if (path.includes("/project-a/skills-lock.json.")) {
        attempts++;
        if (fail) throw new Error("Injected lock write failure.");
      }
      await writeFile(path, value, options);
    },
  });
  await setUpdates(f.settings, "auto");
  const before = await readFile(join(f.projectA, "skills-lock.json"));
  const pass = await f.library.check();
  expect(pass.updates?.[0]).toMatchObject({ copiesUpdated: 0, failedTargets: 1 });
  expect(attempts).toBe(1);
  const failed = (await f.library.readSource("fixture/tools")).uses.find((use) => use.skillKey === "update")!;
  expect(failed).toHaveProperty("lastAutomaticFailure.reason", "Injected lock write failure.");
  const history = await createOperationStore(join(f.data, "omni/operations.json")).read();
  if (history.status !== "ready") throw new Error("History unavailable.");
  const row = history.receipts.find((receipt) => receipt.kind === "skill-management")!;
  expect(row.status).toBe("failed");
  expect(isReceiptRestorable(row, history.receipts)).toBe(false);
  expect(historyTitle(row, english, "en", undefined, history.receipts)).toBe(
    "Failed to update external skills from fixture/tools",
  );
  expect(historyAttribution(row, history.receipts, english)).toContain("Automatic");
  const restarted = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  restarted.bindOperations(f.service);
  expect((await restarted.readSource("fixture/tools")).uses.find((use) => use.id === failed.id)).toHaveProperty(
    "lastAutomaticFailure.reason",
    "Injected lock write failure.",
  );
  expect((await restarted.check()).updates ?? []).toEqual([]);
  expect(attempts).toBe(1);
  expect(await readFile(join(f.projectA, "skills-lock.json"))).toEqual(before);
  await write(f.upstream, "skills/update/next.txt", "New source head\n");
  await commit(f.upstream, "Retry after new source head");
  await git(f.upstream, "push", f.origin, "main");
  await f.library.check();
  expect(attempts).toBe(2);
  const next = await createOperationStore(join(f.data, "omni/operations.json")).read();
  if (next.status !== "ready") throw new Error("History unavailable.");
  expect(next.receipts.filter((receipt) => receipt.kind === "skill-management")).toHaveLength(2);
  fail = false;
  await write(f.upstream, "skills/update/repaired.txt", "Retry after repair and changed source\n");
  await commit(f.upstream, "Retry repaired writer");
  await git(f.upstream, "push", f.origin, "main");
  expect((await f.library.check()).updates?.[0]).toMatchObject({ copiesUpdated: 1, failedTargets: 0 });
  expect(attempts).toBe(3);
  const repaired = (await f.library.readSource("fixture/tools")).uses.find((use) => use.id === failed.id)!;
  expect(repaired.state).toBe("up-to-date");
  expect(repaired).not.toHaveProperty("lastAutomaticFailure");
}, 60000);
