import { describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../src/shared/ipc";
import type { RegistryViewResponse } from "../../src/shared/registry-ipc";
import { observationKey } from "../../src/renderer/app-helpers";
import { observeAdoptionSource } from "../../src/renderer/app-observe-adoption-source";
import { resourceFixture } from "../fixtures/resource-catalogue";

describe("observeAdoptionSource", () => {
  it("loads an active personal source into observation caches without changing the opened entry", async () => {
    const source = resourceFixture.registry.sources[0]!;
    const registry: RegistryViewResponse = { status: "ready", registry: resourceFixture.registry };
    const opened = { status: "granted" as const, entry: source, grantHandle: "source-grant" };
    const observation = resourceFixture.sourceObservation;
    const setObservations = vi.fn();
    const setEntryIdentities = vi.fn();
    const result = await observeAdoptionSource(source.ref.id, {
      api: {
        openEntry: vi.fn(async () => opened),
        observeSource: vi.fn(async () => ({ status: "observed", observation })),
      } as unknown as Pick<DesktopApi, "openEntry" | "observeSource">,
      registry: () => registry,
      registryGeneration: { current: 3 },
      isCurrent: () => true,
      setObservations,
      setEntryIdentities,
    });

    expect(result).toEqual(observation);
    expect(setObservations).toHaveBeenCalledTimes(1);
    expect(setEntryIdentities).toHaveBeenCalledTimes(1);
    const update = setObservations.mock.calls[0]?.[0] as (current: Record<string, unknown>) => Record<string, unknown>;
    expect(update({})).toEqual({ [observationKey(source.ref)]: { status: "observed", observation } });
  });

  it("does not publish a late source response after the selected source changes", async () => {
    const source = resourceFixture.registry.sources[0]!;
    const registry: RegistryViewResponse = { status: "ready", registry: resourceFixture.registry };
    let current = true;
    let release:
      ((value: { status: "observed"; observation: typeof resourceFixture.sourceObservation }) => void) | undefined;
    const setObservations = vi.fn();
    const setEntryIdentities = vi.fn();
    const pending = observeAdoptionSource(source.ref.id, {
      api: {
        openEntry: vi.fn(async () => ({
          status: "granted" as const,
          entry: source,
          grantHandle: "source-grant",
        })),
        observeSource: vi.fn(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        ),
      } as unknown as Pick<DesktopApi, "openEntry" | "observeSource">,
      registry: () => registry,
      registryGeneration: { current: 3 },
      isCurrent: () => current,
      setObservations,
      setEntryIdentities,
    });
    current = false;
    release?.({ status: "observed", observation: resourceFixture.sourceObservation });

    await expect(pending).resolves.toBeNull();
    expect(setObservations).not.toHaveBeenCalled();
    expect(setEntryIdentities).not.toHaveBeenCalled();
  });
});
