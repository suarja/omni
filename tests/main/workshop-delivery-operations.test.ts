import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkshopDeliveryOperations } from "../../src/main/workshop-delivery/operations";
import { createOperationStore } from "../../src/main/operation-store";
import type { WorkshopDeliveryStatus } from "../../src/shared/workshop-delivery-ipc";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-delivery-operations-"));
  roots.push(root);
  const status: WorkshopDeliveryStatus = {
    status: "ready",
    workshop: null,
    projects: [],
    diagnostics: [],
    plugins: {
      status: "ready",
      behind: 1,
      diagnostics: [],
      installations: [
        {
          harness: "claude-code",
          marketplace: "fixture",
          name: "truth",
          scope: "user",
          state: "behind",
          commands: [
            { executable: "claude", args: ["plugin", "marketplace", "update", "fixture", "--json"] },
            { executable: "claude", args: ["plugin", "update", "truth@fixture", "--scope", "user", "--json"] },
          ],
        },
      ],
    },
  };
  const run = vi.fn(async () => {
      status.plugins.behind = 0;
      status.plugins.installations[0]!.state = "current";
    }),
    store = createOperationStore(join(root, "operations.json"));
  const operations = createWorkshopDeliveryOperations({
    userDataPath: root,
    home: root,
    operationStore: store,
    read: async () => status,
    runCommand: run,
  });
  return { root, status, run, store, operations };
}
it("runs the exact previewed provider commands only after Apply and records each result", async () => {
  const f = await fixture();
  const preview = await f.operations.preview({ kind: "update-workshop-plugins", harness: "claude-code" });
  expect(f.run).not.toHaveBeenCalled();
  if (preview.status !== "ready") throw new Error("No preview");
  const result = await f.operations.apply({ planId: preview.plan.planId });
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(result?.receipt.pluginUpdates?.map((command) => command.status)).toEqual(["applied", "applied"]);
  expect((await f.store.read()).status).toBe("ready");
});
it("blocks changed installation targets before running a provider command", async () => {
  const f = await fixture();
  const preview = await f.operations.preview({ kind: "update-workshop-plugins", harness: "claude-code" });
  if (preview.status !== "ready") throw new Error("No preview");
  f.status.plugins.installations[0]!.version = "changed";
  const result = await f.operations.apply({ planId: preview.plan.planId });
  expect(result?.status).toBe("failed");
  expect(f.run).not.toHaveBeenCalled();
});
it("records the successful marketplace refresh and the failed plugin update separately", async () => {
  const f = await fixture();
  f.run
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      throw new Error("CLI refused an unapproved command source");
    });
  const preview = await f.operations.preview({ kind: "update-workshop-plugins", harness: "claude-code" });
  if (preview.status !== "ready") throw new Error("No preview");
  const result = await f.operations.apply({ planId: preview.plan.planId });
  expect(result?.status).toBe("failed");
  expect(result?.receipt.pluginUpdates?.map((command) => command.status)).toEqual(["applied", "failed"]);
});
it("confirms an updated harness even when the other provider records are unreadable", async () => {
  const f = await fixture();
  f.status.plugins.status = "partial";
  f.status.plugins.diagnostics = ["codex plugin records could not be read safely."];
  const preview = await f.operations.preview({ kind: "update-workshop-plugins", harness: "claude-code" });
  if (preview.status !== "ready") throw new Error("No preview");
  const result = await f.operations.apply({ planId: preview.plan.planId });
  expect(result?.status).toBe("applied");
  expect(result?.receipt.pluginUpdates?.map((command) => command.status)).toEqual(["applied", "applied"]);
});
