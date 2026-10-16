// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { expect, it, vi } from "vitest";

import type { ResourceDetails, ResourceSnapshot } from "../../src/domain/resource-catalogue";
import type { SourceSkillRef } from "../../src/domain/skill-reconciliation/types";
import type { ReadSkillVariantOriginResponse } from "../../src/shared/skill-variant-effects";
import { SkillVariantOriginDetails } from "../../src/renderer/canvas/SkillVariantOriginDetails";
import { createResourceCatalogue } from "../../src/domain/resource-catalogue";
import { findObservedSkillVariant } from "../../src/renderer/canvas/skill-variant-navigation";
import { otherSkillRef, skillRef } from "../fixtures/resource-catalogue";
import { deferred, render, snapshot } from "./skill-copy-comparison-fixtures";

const sourceEntry = { kind: "source" as const, id: "source-one" };
const sourceFor = (artifactPath: string): SourceSkillRef => ({
  sourceId: sourceEntry.id,
  packageId: "tools",
  artifactPath,
});

function withObservedVariants(): ResourceSnapshot {
  return {
    ...snapshot,
    roots: snapshot.roots.map((root) => {
      if (root.entry.kind !== "source" || root.entry.id !== sourceEntry.id || root.evidence.status !== "observed")
        return root;
      const packages = [
        ...(root.evidence.observation.inventory.packages ?? []),
        {
          id: "tools",
          relativeRoot: "packages/tools",
          displayName: "Tools",
          format: "omni" as const,
          manifestPaths: ["packages/tools/omni.plugin.json"],
          artifactIds: ["variant-a", "variant-b"],
        },
      ];
      return {
        ...root,
        evidence: {
          ...root.evidence,
          observation: {
            ...root.evidence.observation,
            inventory: { ...root.evidence.observation.inventory, packages },
          },
        },
      };
    }),
  };
}

function details(artifactId: string, artifactPath: string): ResourceDetails {
  return {
    resource: {
      ref: { kind: "artifact", entry: sourceEntry, artifactId },
      label: artifactId,
      kind: "artifact",
      artifactKind: "skill",
      state: "observed",
      availability: "available",
      relativePath: `packages/tools/${artifactPath}/SKILL.md`,
    },
    parent: { kind: "package", entry: sourceEntry, packageId: "tools" },
    diagnostics: [],
    files: [{ relativePath: `packages/tools/${artifactPath}/SKILL.md`, role: "readme" }],
    uses: { status: "ready", bindings: [] },
  };
}

function originResponse(source: SourceSkillRef, variantId: string): ReadSkillVariantOriginResponse {
  return {
    status: "ready",
    source,
    origin: {
      schemaVersion: 1,
      variantId,
      forkOf: "223e4567-e89b-42d3-a456-426614174000",
      capturedAt: "2026-10-09T10:00:00.000Z",
      capturedFrom: {
        location: { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/demo" },
        revision: { algorithm: "omni-tree-v1", hash: "a".repeat(64), files: [] },
      },
    },
  };
}

it("reads the exact observed variant origin and ignores an older selection response", async () => {
  const firstSource = sourceFor("skills/demo-personal");
  const secondSource = sourceFor("skills/other-personal");
  const first = deferred<ReadSkillVariantOriginResponse>();
  const second = deferred<ReadSkillVariantOriginResponse>();
  const readSkillVariantOrigin = vi.fn((source: SourceSkillRef) =>
    source.artifactPath === firstSource.artifactPath ? first.promise : second.promise,
  );
  const currentSnapshot = withObservedVariants();

  function Harness(): ReactElement {
    const [selected, setSelected] = useState("variant-a");
    const variant = selected === "variant-a" ? firstSource : secondSource;
    return (
      <>
        <button onClick={() => setSelected("variant-b")} type="button">
          Open second variant
        </button>
        <SkillVariantOriginDetails
          api={{ readSkillVariantOrigin }}
          details={details(selected, variant.artifactPath)}
          snapshot={currentSnapshot}
        />
      </>
    );
  }

  const rendered = render(<Harness />);
  try {
    await act(async () => Promise.resolve());
    expect(readSkillVariantOrigin).toHaveBeenCalledWith(firstSource);
    await act(async () => rendered.container.querySelector("button")?.click());
    expect(readSkillVariantOrigin).toHaveBeenLastCalledWith(secondSource);
    await act(async () => {
      second.resolve(originResponse(secondSource, "423e4567-e89b-42d3-a456-426614174000"));
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve(originResponse(firstSource, "523e4567-e89b-42d3-a456-426614174000"));
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("423e4567-e89b-42d3-a456-426614174000");
    expect(rendered.container.textContent).not.toContain("523e4567-e89b-42d3-a456-426614174000");
    expect(rendered.container.textContent).toContain(".agents/skills/demo");
  } finally {
    act(() => rendered.root.unmount());
  }
});

it("opens only the exact observed skill inside the capture destination", () => {
  const catalogue = createResourceCatalogue(snapshot);
  const records = catalogue.search("");
  expect(
    findObservedSkillVariant(catalogue, records, {
      sourceId: "source-one",
      packageId: "pstack",
      artifactPath: "skills/review",
    })?.ref,
  ).toEqual(skillRef);
  expect(
    findObservedSkillVariant(catalogue, records, {
      sourceId: "source-one",
      packageId: "other",
      artifactPath: "skills/review",
    })?.ref,
  ).toEqual(otherSkillRef);
  expect(
    findObservedSkillVariant(catalogue, records, {
      sourceId: "different-source",
      packageId: "pstack",
      artifactPath: "skills/review",
    }),
  ).toBeUndefined();
});
