// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { Observation } from "../../src/domain/project-source-registry";
import { createResourceCatalogue } from "../../src/domain/resource-catalogue";
import { findFreshSkillVariant, useSkillVariantNavigation } from "../../src/renderer/canvas/skill-variant-navigation";
import { snapshot, deferred, render } from "./skill-copy-comparison-fixtures";

const source = { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" };
const root = snapshot.roots.find((item) => item.entry.kind === "source" && item.entry.id === source.sourceId)!;
if (root.evidence.status !== "observed") throw new Error("Observed source fixture required.");
const observation: Observation = {
  ...root.evidence.observation,
  inventory: {
    ...root.evidence.observation.inventory,
    packages: root.evidence.observation.inventory.packages?.map((pkg) =>
      pkg.id === source.packageId ? { ...pkg, format: "omni" as const } : pkg,
    ),
  },
};

it("resolves fresh variants only within the exact observed source package", () => {
  const ref = findFreshSkillVariant(observation, source);
  expect(ref).toMatchObject({ kind: "artifact", entry: { kind: "source", id: source.sourceId } });
  expect(findFreshSkillVariant(observation, { ...source, sourceId: "another-source" })).toBeUndefined();
  expect(findFreshSkillVariant(observation, { ...source, packageId: "missing" })).toBeUndefined();
  expect(findFreshSkillVariant(observation, { ...source, artifactPath: "skills/missing" })).toBeUndefined();
});

it("opens a freshly observed variant after a source refresh clears cached canvas records", async () => {
  const onCloseChanges = vi.fn();
  const onNavigate = vi.fn();
  const onObserveSource = vi.fn(async () => observation);
  function Host() {
    const open = useSkillVariantNavigation({
      catalogue: createResourceCatalogue(snapshot),
      records: [],
      onRefresh: vi.fn(),
      onObserveSource,
      onCloseChanges,
      onNavigate,
    });
    return <button onClick={() => void open(source)}>Open</button>;
  }
  const view = render(<Host />);
  try {
    await act(async () => view.container.querySelector("button")!.click());
    expect(onObserveSource).toHaveBeenCalledWith(source.sourceId, expect.any(Function));
    expect(onCloseChanges).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith({
      screen: "resource-canvas",
      context: findFreshSkillVariant(observation, source),
    });
  } finally {
    act(() => view.root.unmount());
  }
});

it("ignores a source response after the canvas host unmounts", async () => {
  const pending = deferred<Observation | null>();
  const onNavigate = vi.fn();
  function Host() {
    const open = useSkillVariantNavigation({
      catalogue: createResourceCatalogue(snapshot),
      records: [],
      onRefresh: vi.fn(),
      onObserveSource: async () => pending.promise,
      onCloseChanges: vi.fn(),
      onNavigate,
    });
    return <button onClick={() => void open(source)}>Open</button>;
  }
  const view = render(<Host />);
  act(() => view.container.querySelector("button")!.click());
  act(() => view.root.unmount());
  await act(async () => {
    pending.resolve(observation);
    await pending.promise;
  });
  expect(onNavigate).not.toHaveBeenCalled();
});
