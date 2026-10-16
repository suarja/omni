import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scanInventory } from "../../src/application/inventory";
import { createLocalInventoryPort } from "../../src/adapters/inventory/local-filesystem";
import { sourceLayoutInventoryDetector } from "../../src/adapters/inventory/source-layout";
import { parseInventorySnapshot } from "../../src/shared/inventory-dto";
import { parseObservationResponse } from "../../src/shared/registry-ipc";
import { parseProjectInspectionResponse } from "../../src/shared/project-inspection-ipc";

const roots: string[] = [];

async function createMarketplace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-package-id-"));
  roots.push(root);
  await mkdir(join(root, "plugins/review"), { recursive: true });
  await writeFile(
    join(root, "omni.marketplace.json"),
    JSON.stringify({ name: "Fixture marketplace", packages: [{ path: "plugins/review" }] }),
  );
  await writeFile(
    join(root, "plugins/review/omni.plugin.json"),
    JSON.stringify({ id: "review-tools", name: "Review" }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("observed package manifest ID IPC contract", () => {
  it("passes adapter packages through inventory, observation, and project inspection parsers", async () => {
    const root = await createMarketplace();
    const snapshot = await scanInventory(
      {
        approvedRoot: root,
        rootHandle: "marketplace-grant",
        displayRoot: "marketplace",
        scope: "source",
        observedAt: "2026-10-16T10:00:00.000Z",
      },
      {
        filesystem: createLocalInventoryPort(root),
        detectors: [sourceLayoutInventoryDetector],
        git: {
          async collect() {
            return { scopes: [], diagnostics: [] };
          },
        },
      },
    );
    const pkg = snapshot.packages?.[0];
    expect(pkg).toMatchObject({ id: "plugins/review", manifestId: "review-tools" });

    expect(() => parseInventorySnapshot(snapshot)).not.toThrow(
      'Observed package has an unexpected field "manifestId".',
    );
    expect(parseInventorySnapshot(snapshot).packages?.[0]?.manifestId).toBe("review-tools");

    const observation = parseObservationResponse({
      status: "observed",
      observation: {
        subject: { kind: "source", id: "fixture-source" },
        observedAt: snapshot.observedAt,
        inventory: snapshot,
      },
    });
    expect(observation).toMatchObject({
      status: "observed",
      observation: { inventory: { packages: [{ manifestId: "review-tools" }] } },
    });

    const inspection = parseProjectInspectionResponse({
      status: "inspected",
      grantHandle: "marketplace-grant",
      displayName: "Fixture marketplace",
      displayRoot: "marketplace",
      inventory: { ...snapshot, rootHandle: "marketplace-grant" },
    });
    expect(inspection).toMatchObject({ inventory: { packages: [{ manifestId: "review-tools" }] } });
  });
});
