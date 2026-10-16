import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLocalJsonRegistryStore } from "../../src/adapters/registry/local-json";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createLastSeenStore } from "../../src/main/agent-gateway/last-seen-store";
import { createBindingsStore } from "../../src/main/bindings-store";
import { createOperationStore } from "../../src/main/operation-store";
import { createSettingsStore } from "../../src/main/settings-store";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { readFirstLaunch } from "../../src/main/academy";
import { inspectBootstrapStatus } from "../../packages/omni-mcp/src/bootstrap-status";
import { readProjectSkillManifest } from "../../src/main/skill-management/project-skill-manifest";
import { createProjectSkillParking } from "../../src/main/skill-management/project-skill-parking";
import {
  parseAgentMutationResponse,
  parseAgentRequestResponse,
  parseAgentWriteRequest,
} from "../../src/shared/agents-ipc";
import { parsePreviewImportRequest } from "../../src/shared/operations-import-ipc";
import { parseAddToProjectRequest } from "../../src/shared/operations-add-to-project-ipc";
import { createAgentRequestRefresher } from "../../src/main/agent-gateway/refresh-request";
import { createAgentApply } from "../../src/main/agent-gateway/router-apply";
import { createAgentReceiptReader } from "../../src/main/agent-gateway/router-receipt";

const FIXTURES = join(import.meta.dirname, "../fixtures/persisted-state/rc9");
const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const INTENT = "44444444-4444-4444-8444-444444444444";
let root: string;

async function installFixture(name: string, relativePath = `omni/${name}`): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await copyFile(join(FIXTURES, name), path);
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omni-previous-release-"));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe("previous-release persisted stores: rc.9", () => {
  it("loads three legacy captures through the store and preload response without inventing descriptions", async () => {
    const path = await installFixture("agent-requests.json");
    const original = await readFile(path, "utf8");
    const requests = await createAgentRequestsStore(path, () => NOW).all();
    const response = parseAgentRequestResponse({ status: "ready", requests });
    expect(response.requests).toEqual(JSON.parse(original).requests);
    expect(response.requests).toHaveLength(3);
    expect(response.requests.map((request) => request.applyOutcome?.status)).toEqual(["applied", "applied", undefined]);
    for (const request of response.requests) {
      expect(request.status).toBe("approved");
      expect(request.request.kind).toBe("import-artifact");
      if (request.request.kind === "import-artifact") expect(request.request.target).not.toHaveProperty("description");
    }
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("still refuses legacy capture payloads as new agent and desktop input", async () => {
    const path = await installFixture("agent-requests.json");
    const fixture = JSON.parse(await readFile(path, "utf8"));
    for (const record of fixture.requests) {
      expect(() => parseAgentWriteRequest(record.request)).toThrow(/description/i);
      await expect(
        createAgentRequestsStore(path, () => NOW).create({ request: record.request, plan: record.plan }),
      ).rejects.toThrow(/description/i);
      expect(() =>
        parsePreviewImportRequest({
          kind: "import-artifact",
          source: { kind: "project", id: record.request.projectId, grantHandle: "grant" },
          relativePath: record.request.relativePath,
          target: record.request.target,
        }),
      ).toThrow(/description/i);
      expect(() =>
        parseAddToProjectRequest({
          kind: "add-to-project",
          entry: { ownerRepo: "example/release-tools", skill: "release-check" },
          projectId: record.request.projectId,
          grantHandle: "grant",
          newPackageName: record.request.target.newPackageName,
          harnessIds: ["codex"],
        }),
      ).toThrow(/description/i);
    }
  });

  it("rejects malformed historical capture entries at the boundary and quarantines them on startup", async () => {
    const original = JSON.parse(await readFile(join(FIXTURES, "agent-requests.json"), "utf8"));
    for (const target of [{ description: "" }, { description: 42 }, { unknown: true }]) {
      const path = join(root, `requests-${Object.keys(target)[0]}-${String(Object.values(target)[0])}.json`);
      const record = structuredClone(original.requests[0]);
      Object.assign(record.request.target, target);
      await writeFile(path, JSON.stringify({ schemaVersion: 1, requests: [record] }));
      expect(() => parseAgentMutationResponse(record)).toThrow();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(await createAgentRequestsStore(path, () => NOW).all()).toEqual([]);
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
      }
    }
  });

  it("preserves legacy history when a valid new capture is persisted and the store is reopened", async () => {
    const path = await installFixture("agent-requests.json");
    const store = createAgentRequestsStore(path, () => NOW);
    const legacy = await store.all();
    const first = legacy[0]!;
    if (first.request.kind !== "import-artifact") throw new Error("Capture fixture is invalid.");
    await store.create({
      request: parseAgentWriteRequest({
        ...first.request,
        target: { ...first.request.target, description: "Checks local release files." },
      }),
      plan: first.plan,
    });
    const reloaded = await createAgentRequestsStore(path, () => NOW).all();
    expect(reloaded).toHaveLength(4);
    expect(reloaded.filter((request) => request.status === "approved")).toEqual(legacy);
  });

  it("loads old pending captures but requires a description before refreshing their effects", async () => {
    const path = await installFixture("agent-requests.json");
    const fixture = JSON.parse(await readFile(path, "utf8"));
    const record = { ...fixture.requests[2], status: "pending", approval: "omni" };
    delete record.receiptId;
    await writeFile(path, JSON.stringify({ schemaVersion: 1, requests: [record] }));
    const store = createAgentRequestsStore(path, () => NOW);
    expect(await store.list()).toHaveLength(1);
    const refresh = createAgentRequestRefresher({
      requests: store,
      registry: {} as never,
      settings: {} as never,
      service: {} as never,
      previewPlan: async () => {
        throw new Error("Legacy input must not reach preview.");
      },
    });
    await expect(refresh(record.requestId)).rejects.toThrow(/description/i);
    expect(await store.list()).toHaveLength(1);
  });

  it("requires a description before an unreceipted old capture can write new files", async () => {
    const path = await installFixture("agent-requests.json");
    const fixture = JSON.parse(await readFile(path, "utf8"));
    const record = fixture.requests[2];
    record.status = "awaiting-agent";
    delete record.receiptId;
    await writeFile(path, JSON.stringify({ schemaVersion: 1, requests: [record] }));
    const store = createAgentRequestsStore(path, () => NOW);
    const apply = createAgentApply({
      requests: store,
      operations: {} as never,
      operationStore: {} as never,
      now: () => NOW,
      receipt: async () => {
        throw new Error("No receipt should be requested.");
      },
      previewPlan: async () => {
        throw new Error("Legacy input must not reach preview.");
      },
    });
    await expect(apply({ requestId: record.requestId }, {} as never)).rejects.toThrow(/description/i);
    const lease = await store.acquireApplyAuthorization(record.requestId);
    await store.releaseApplyAuthorization(record.requestId, lease.leaseId);
    expect(await store.get(record.requestId)).not.toHaveProperty("applyOutcome");
  });

  it("loads operation history before agentSetup and copiedFrom existed", async () => {
    const path = await installFixture("operations.json");
    const fixture = JSON.parse(await readFile(path, "utf8"));
    await expect(createOperationStore(path).read()).resolves.toEqual({ status: "ready", receipts: fixture.receipts });
  });

  it("returns the recorded receipts for all three old captures without repeating their writes", async () => {
    const path = await installFixture("agent-requests.json");
    const operationsPath = await installFixture("operations.json");
    const requests = createAgentRequestsStore(path, () => NOW);
    const operationStore = createOperationStore(operationsPath);
    const apply = createAgentApply({
      requests,
      operationStore,
      operations: {} as never,
      now: () => NOW,
      receipt: (request) => createAgentReceiptReader(requests, operationStore)({ requestId: request.requestId }),
      previewPlan: async () => {
        throw new Error("Completed history must not repeat its writes.");
      },
    });
    for (const index of [1, 2, 3]) {
      await expect(apply({ requestId: `capture-${index}` }, {} as never)).resolves.toMatchObject({
        status: "applied",
        receipt: { operationId: `capture-receipt-${index}` },
      });
    }
  });

  it("loads settings without installedByVersion while preserving existing preferences", async () => {
    const path = await installFixture("settings.json");
    const fixture = JSON.parse(await readFile(path, "utf8"));
    await expect(createSettingsStore(path).read()).resolves.toEqual({
      ...fixture,
      schemaVersion: 8,
      externalLibrary: { updates: "auto" },
    });
  });

  it("loads existing bindings", async () => {
    const path = await installFixture("bindings.json");
    const fixture = JSON.parse(await readFile(path, "utf8"));
    await expect(createBindingsStore(path).read()).resolves.toEqual({ status: "ready", bindings: fixture.bindings });
  });

  it("loads registered projects and personal sources", async () => {
    const path = await installFixture("project-source-registry.json");
    const fixture = JSON.parse(await readFile(path, "utf8"));
    await expect(createLocalJsonRegistryStore(path).read()).resolves.toEqual({ status: "ready", state: fixture });
  });

  it("loads logical skills and managed uses", async () => {
    const path = await installFixture("skill-relationships.json");
    const fixture = JSON.parse(await readFile(path, "utf8"));
    await expect(createSkillRelationshipStore(path).read()).resolves.toEqual({ status: "ready", state: fixture });
  });

  it("loads agent last-seen timestamps", async () => {
    const path = await installFixture("agent-last-seen.json");
    await expect(createLastSeenStore(root).lastSeen()).resolves.toEqual(JSON.parse(await readFile(path, "utf8")));
  });

  it("loads the original first-launch timestamp without resetting it", async () => {
    const path = await installFixture("first-launch.json");
    await expect(readFirstLaunch(root, () => new Date(NOW).toISOString())).resolves.toEqual(
      JSON.parse(await readFile(path, "utf8")),
    );
  });

  it("recognizes the previous desktop marker through the MCP bootstrap reader", async () => {
    await installFixture("desktop.json");
    const result = await inspectBootstrapStatus({
      userDataPath: root,
      homeDir: join(root, "home"),
      desktopInstallPaths: [],
    });
    expect(result.desktop.status).toBe("installed");
  });

  it("loads a project skill backup using the previous action enum", async () => {
    const path = await installFixture(
      "project-skill-manifest.json",
      `omni/backups/project-skills/${INTENT}/manifest.json`,
    );
    await expect(readProjectSkillManifest(root, INTENT)).resolves.toEqual(JSON.parse(await readFile(path, "utf8")));
  });

  it("loads parked project skills", async () => {
    const path = await installFixture("parked-skills.json", "omni/parked/index.json");
    await expect(createProjectSkillParking(root).read()).resolves.toEqual(JSON.parse(await readFile(path, "utf8")));
  });
});

describe("previous-release settings: rc.11", () => {
  it("loads the v6 settings shape without rewriting preferences or the historical file", async () => {
    const path = join(root, "omni/settings.json");
    await mkdir(dirname(path), { recursive: true });
    await copyFile(join(import.meta.dirname, "../fixtures/persisted-state/rc11/settings.json"), path);
    const before = await readFile(path, "utf8"),
      fixture = JSON.parse(before);
    expect(await createSettingsStore(path).read()).toEqual({
      ...fixture,
      schemaVersion: 8,
      externalLibrary: { updates: "auto" },
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });
});

describe("previous-release persisted registry: rc.10", () => {
  it("loads the rc.10 workshop without rewriting its registry", async () => {
    const path = join(root, "omni/project-source-registry.json");
    await mkdir(dirname(path), { recursive: true });
    await copyFile(join(import.meta.dirname, "../fixtures/persisted-state/rc10/project-source-registry.json"), path);
    const before = await readFile(path, "utf8");
    const loaded = await createLocalJsonRegistryStore(path).read();
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") throw new Error("Fixture registry is unavailable.");
    const { activeWorkshop } = await import("../../src/domain/source-roles");
    expect(activeWorkshop(loaded.state)?.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
