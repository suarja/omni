import { describe, expect, it } from "vitest";
import { parseRegistryState, registerSource, createRegistryView } from "../../src/domain/project-source-registry";

const createdAt = "2026-10-12T10:00:00.000Z";
const workshop = {
  id: "workshop",
  displayName: "Workshop",
  locator: { kind: "local-directory", canonicalPath: "/fixture/workshop" },
  ownership: "personal" as const,
  createdAt,
};
const storefront = {
  ...workshop,
  id: "storefront",
  role: "storefront" as const,
  locator: { kind: "local-directory", canonicalPath: "/fixture/storefront" },
};
const state = (sources: unknown[]) => parseRegistryState({ schemaVersion: 1, revision: 0, projects: [], sources });

describe("workshop and storefront roles", () => {
  it("preserves source roles and typed workshop conflicts across registry IPC", async () => {
    const ipc = await import("../../src/shared/registry-ipc");
    const registry = createRegistryView(state([storefront, workshop]));
    expect(ipc.parseRegistryViewResponse({ status: "ready", registry })).toEqual({ status: "ready", registry });
    const conflict = { status: "workshop-conflict", reason: "active-workshop-exists", workshopId: "workshop" };
    expect(ipc.parseRegisterSourceResponse(conflict)).toEqual(conflict);
    expect(ipc.parseRegistryMutationResponse(conflict)).toEqual(conflict);
    expect(() => ipc.parseRegisterSourceRequest({ ownership: "external", role: "storefront" })).toThrow(/role/i);
  });
  it("selects the legacy workshop even when a storefront was registered first", async () => {
    const roles = await import("../../src/domain/source-roles");
    const registry = state([storefront, workshop]);
    expect(roles.activeWorkshop(registry)?.id).toBe("workshop");
    expect(roles.activeWorkshop(createRegistryView(registry))?.ref.id).toBe("workshop");
    expect(roles.activeStorefronts(registry).map((source) => source.id)).toEqual(["storefront"]);
  });
  it("refuses a second workshop with a typed reason and unchanged state", () => {
    const registry = state([workshop]);
    const decision = registerSource(registry, {
      id: "second",
      displayName: "Second",
      canonicalPath: "/fixture/second",
      ownership: "personal" as const,
      createdAt,
    });
    expect(decision.result).toMatchObject({
      status: "workshop-conflict",
      reason: "active-workshop-exists",
      workshopId: "workshop",
    });
    expect(decision.nextState).toBe(registry);
  });
  it("allows unlimited storefronts and refuses a role change at an existing path", async () => {
    const roles = await import("../../src/domain/source-roles");
    const registry = state([workshop, storefront]);
    const added = registerSource(registry, {
      id: "another",
      displayName: "Another",
      canonicalPath: "/fixture/another",
      ownership: "personal" as const,
      role: "storefront" as const,
      createdAt,
    });
    expect(added.result.status).toBe("ready");
    expect(roles.activeStorefronts(added.nextState)).toHaveLength(2);
    expect(
      registerSource(registry, {
        displayName: "Changed",
        canonicalPath: "/fixture/storefront",
        ownership: "personal" as const,
        createdAt,
      }).result.status,
    ).toBe("classification-conflict");
  });
  it("refuses reactivating a workshop while another one is active", () => {
    const registry = state([
      { ...workshop, archivedAt: createdAt },
      { ...workshop, id: "other", locator: { kind: "local-directory", canonicalPath: "/fixture/other" } },
    ]);
    expect(
      registerSource(registry, {
        displayName: "Workshop",
        canonicalPath: "/fixture/workshop",
        ownership: "personal" as const,
        createdAt,
      }).result.status,
    ).toBe("workshop-conflict");
  });
  it("rejects external roles and unknown role values", () => {
    expect(() => state([{ ...storefront, ownership: "external" }])).toThrow(/role/i);
    expect(() => state([{ ...workshop, role: "unknown" }])).toThrow(/role/i);
  });
  it("refuses a storefront skill target with a typed error", async () => {
    const roles = await import("../../src/domain/source-roles");
    expect(() => roles.assertWorkshopTarget(storefront)).toThrowError(
      expect.objectContaining({ code: "storefront-target" }),
    );
    expect(() => roles.assertWorkshopTarget(workshop)).not.toThrow();
  });
});
