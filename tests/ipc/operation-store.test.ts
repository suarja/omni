import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOperationStore } from "../../src/main/operation-store";
import type { OperationReceipt } from "../../src/shared/operations-ipc";

const roots: string[] = [];
const receipt = (id: string, time: string): OperationReceipt => ({
  operationId: id,
  kind: "create-marketplace",
  status: "applied",
  appliedAt: time,
  displayTarget: id,
  actions: [],
  git: { mode: "unavailable" },
  registered: null,
});

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("versioned operation store", () => {
  it("rejects an aggregate receipt without its exact result and child links", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-aggregate-store-"));
    roots.push(root);
    const store = createOperationStore(join(root, "operations.json"));
    const parent = { ...receipt("parent", "2026-10-07T10:00:00.000Z"), kind: "skill-management" as const };
    await expect(store.append(parent)).rejects.toThrow(/aggregate/i);
    const summary = {
      intentId: "parent",
      operationId: "parent",
      status: "applied" as const,
      source: { status: "updated" as const },
      targets: [],
      receiptIds: ["child-a"],
      issues: [],
      recoveryAvailable: false,
    };
    await expect(store.append({ ...parent, children: ["child-b"], skillManagement: summary })).rejects.toThrow(
      /aggregate/i,
    );
  });

  it("starts empty, persists receipts newest first, and uses recoverable modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-operation-store-"));
    roots.push(root);
    const filePath = join(root, "omni", "operations.json");
    const store = createOperationStore(filePath);
    await expect(store.read()).resolves.toEqual({ status: "ready", receipts: [] });
    await expect(store.append(receipt("first", "2026-09-12T10:00:00.000Z"))).resolves.toMatchObject({
      status: "ready",
    });
    await store.append(receipt("second", "2026-09-12T11:00:00.000Z"));
    await expect(store.read()).resolves.toEqual({
      status: "ready",
      receipts: [receipt("second", "2026-09-12T11:00:00.000Z"), receipt("first", "2026-09-12T10:00:00.000Z")],
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${filePath}.bak`)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(filePath, "utf8")) as {
      schemaVersion: number;
      receipts: { operationId: string }[];
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.receipts[0]?.operationId).toBe("second");
  });

  it("fails closed on unsupported data", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-operation-store-corrupt-"));
    roots.push(root);
    const filePath = join(root, "operations.json");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(filePath, JSON.stringify({ schemaVersion: 2, receipts: [] })),
    );
    const store = createOperationStore(filePath);
    await expect(store.read()).resolves.toMatchObject({ status: "corrupt", recoveryAvailable: false });
    await expect(store.append(receipt("blocked", "2026-09-12T10:00:00.000Z"))).resolves.toMatchObject({
      status: "corrupt",
    });
  });

  it("refuses to write a receipt its own reader would reject, keeping the file and backup readable", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-operation-store-storable-"));
    roots.push(root);
    const filePath = join(root, "operations.json");
    const store = createOperationStore(filePath);
    await store.append(receipt("first", "2026-09-12T10:00:00.000Z"));
    const malformed = {
      ...receipt("second", "2026-09-12T11:00:00.000Z"),
      git: { mode: "unavailable", warnings: [] },
    } as unknown as OperationReceipt;
    await expect(store.append(malformed)).rejects.toThrow(/Receipt cannot be stored/);
    await expect(store.read()).resolves.toMatchObject({ status: "ready", receipts: [{ operationId: "first" }] });
    const fresh = JSON.parse(await readFile(filePath, "utf8")) as { receipts: { operationId: string }[] };
    expect(fresh.receipts.map((entry) => entry.operationId)).toEqual(["first"]);
  });

  it("reads a file left by the 36-pre first pass (restore-add-to-project with git.warnings) and persists it clean", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-operation-store-legacy-"));
    roots.push(root);
    const filePath = join(root, "operations.json");
    const legacy = {
      ...receipt("legacy-restore", "2026-09-15T02:17:37.946Z"),
      kind: "restore-add-to-project",
      git: { mode: "unavailable", warnings: [] },
    };
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(filePath, JSON.stringify({ schemaVersion: 1, receipts: [legacy] })),
    );
    const store = createOperationStore(filePath);
    await expect(store.read()).resolves.toMatchObject({
      status: "ready",
      receipts: [{ operationId: "legacy-restore", git: { mode: "unavailable" } }],
    });
    await store.append(receipt("next", "2026-09-15T03:00:00.000Z"));
    const fresh = JSON.parse(await readFile(filePath, "utf8")) as { receipts: { git: Record<string, unknown> }[] };
    expect(fresh.receipts.every((entry) => !("warnings" in entry.git))).toBe(true);
  });
});
