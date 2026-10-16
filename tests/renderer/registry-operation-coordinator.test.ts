import { describe, expect, it } from "vitest";

import { createRegistryOperationCoordinator } from "../../src/renderer/registry/registry-operation-coordinator";

describe("registry operation coordinator", () => {
  it("rejects an external refresh while a registration mutation is active", () => {
    const coordinator = createRegistryOperationCoordinator();
    const registration = coordinator.beginMutation();

    expect(registration).not.toBeNull();
    expect(coordinator.beginLoad()).toBeNull();
  });

  it("rejects a competing lifecycle mutation while registration is active", () => {
    const coordinator = createRegistryOperationCoordinator();

    expect(coordinator.beginMutation()).not.toBeNull();
    expect(coordinator.beginMutation()).toBeNull();
  });

  it("does not let a stale internal token authorize a later load", () => {
    const coordinator = createRegistryOperationCoordinator();
    const firstMutation = coordinator.beginMutation();

    expect(firstMutation).not.toBeNull();
    coordinator.endMutation(firstMutation!);
    const laterMutation = coordinator.beginMutation();

    expect(laterMutation).not.toBeNull();
    expect(coordinator.beginLoad(firstMutation!)).toBeNull();
  });

  it("authorizes the active mutation own post-registration refresh", () => {
    const coordinator = createRegistryOperationCoordinator();
    const mutation = coordinator.beginMutation();

    expect(mutation).not.toBeNull();
    const load = coordinator.beginLoad(mutation!);

    expect(load).not.toBeNull();
    expect(coordinator.isLoadAuthorized(load!)).toBe(true);
  });

  it("invalidates an authorized load when its mutation ends", () => {
    const coordinator = createRegistryOperationCoordinator();
    const mutation = coordinator.beginMutation();
    const load = coordinator.beginLoad(mutation!);

    expect(load).not.toBeNull();
    coordinator.endMutation(mutation!);

    expect(coordinator.isLoadAuthorized(load!)).toBe(false);
  });
});
