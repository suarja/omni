// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { useSkillCopies } from "../../src/renderer/canvas/use-skill-copies";
import { useProjectSkillAttention } from "../../src/renderer/canvas/use-project-skill-attention";
import { createCanvasSession } from "../../src/renderer/canvas/spatial/canvas-session";
import type { SkillCopiesState } from "../../src/renderer/canvas/use-skill-copies";
import type { ProjectSkillGroup } from "../../src/domain/resource-catalogue";
import type { ObserveSkillCopiesResponse } from "../../src/shared/skill-reconciliation-ipc";

test("a refreshed inventory reobserves contents even when copy paths stay unchanged", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const observeSkillCopies = vi.fn(async (): Promise<ObserveSkillCopiesResponse> => ({
    status: "ready",
    groups: [],
    retainedSkills: [],
    managedUses: [],
    storeRevision: 1,
  }));
  const api = { observeSkillCopies };
  const onEnsureGrant = async () => "grant";
  const groups: readonly ProjectSkillGroup[] = [
    {
      id: "individual-skills",
      category: "individual",
      label: "Individual skills",
      locations: [
        {
          ref: { kind: "artifact", artifactId: "review", entry: { kind: "project", id: "p1" } },
          relativePath: ".agents/skills/review/SKILL.md",
        },
      ],
    },
  ];
  function Observation({
    refreshedGroups,
    observationKey = "first-scan",
  }: {
    refreshedGroups: readonly ProjectSkillGroup[];
    observationKey?: string;
  }) {
    const state = useSkillCopies({
      projectId: "p1",
      groups: refreshedGroups,
      api,
      onEnsureGrant,
      ...{ observationKey },
    });
    return <span>{state.status}</span>;
  }
  try {
    await act(async () => root.render(<Observation refreshedGroups={groups} />));
    expect(observeSkillCopies).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Observation refreshedGroups={groups} />));
    expect(observeSkillCopies).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Observation refreshedGroups={groups.map((group) => ({ ...group }))} />));
    expect(observeSkillCopies).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Observation refreshedGroups={groups} observationKey="refreshed-scan" />));
    expect(observeSkillCopies).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("ready");
  } finally {
    act(() => root.unmount());
  }
});

test("an empty inventory still refreshes and retains known unavailable skill locations", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const session = createCanvasSession();
  const location = { projectId: "p1", harnessId: "codex" as const, folderPath: ".agents/skills/retained" };
  const retainedSkill = {
    record: { skillId: "retained", label: "retained", evidence: "individual" as const, locations: [location] },
    locations: [{ location, read: { status: "unavailable" as const, reason: "missing" as const } }],
  };
  const observeSkillCopies = vi.fn(async (): Promise<ObserveSkillCopiesResponse> => ({
    status: "ready",
    groups: [],
    retainedSkills: [retainedSkill],
    managedUses: [],
    storeRevision: 7,
  }));
  const api = { observeSkillCopies };
  const roots = [{ projectId: "p1", rootKey: "root-a" }];
  const onEnsureGrant = async () => "grant";
  function Observation() {
    const copies = useSkillCopies({ projectId: "p1", groups: [], observationKey: "scan-one", api, onEnsureGrant });
    const attention = useProjectSkillAttention({
      projectId: "p1",
      roots,
      observationKey: "scan-one",
      observedAt: "2026-10-08T10:00:00.000Z",
      skillCopies: copies,
      session,
    });
    return (
      <span>{`${copies.status}:${copies.status === "ready" ? copies.retainedSkills.length : 0}:${attention.get("p1")?.state ?? "quiet"}`}</span>
    );
  }
  try {
    await act(async () => root.render(<Observation />));
    expect(observeSkillCopies).toHaveBeenCalledTimes(1);
    expect(observeSkillCopies).toHaveBeenCalledWith({ projectId: "p1", grantHandle: "grant", groups: [] });
    expect(container.textContent).toBe("ready:1:unavailable");
    expect(session.readProjectAttention("p1")).toMatchObject({
      rootKey: "root-a",
      observationKey: "scan-one",
      freshness: "fresh",
      state: "unavailable",
      reasons: ["unavailable"],
    });
  } finally {
    act(() => root.unmount());
  }
});

test("loading keeps the last attention, failed refresh adds unavailable, and root changes clear it", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const session = createCanvasSession();
  const previous = {
    projectId: "p1",
    rootKey: "root-a",
    observationKey: "scan-one",
    freshness: "fresh" as const,
    observedAt: "2026-10-08T10:00:00.000Z",
    state: "copy-difference" as const,
    reasons: ["copy-difference"] as const,
  };
  session.writeProjectAttention(previous);
  const loading: SkillCopiesState = { status: "loading", byGroup: new Map(), retainedSkills: [] };
  const unavailable: SkillCopiesState = { status: "unavailable", byGroup: new Map(), retainedSkills: [] };
  function Attention({
    roots,
    skillCopies,
  }: {
    roots: readonly { projectId: string; rootKey: string }[];
    skillCopies: SkillCopiesState;
  }) {
    const attention = useProjectSkillAttention({
      projectId: "p1",
      roots,
      observationKey: "scan-two",
      observedAt: "2026-10-08T10:01:00.000Z",
      skillCopies,
      session,
    });
    return <span>{JSON.stringify(attention.get("p1") ?? null)}</span>;
  }
  try {
    await act(async () =>
      root.render(<Attention roots={[{ projectId: "p1", rootKey: "root-a" }]} skillCopies={loading} />),
    );
    expect(session.readProjectAttention("p1")).toEqual(previous);
    expect(container.textContent).toContain("copy-difference");

    await act(async () =>
      root.render(<Attention roots={[{ projectId: "p1", rootKey: "root-a" }]} skillCopies={unavailable} />),
    );
    expect(session.readProjectAttention("p1")).toMatchObject({
      observationKey: "scan-two",
      freshness: "failed",
      state: "copy-difference",
      reasons: ["copy-difference", "unavailable"],
    });

    await act(async () =>
      root.render(<Attention roots={[{ projectId: "p1", rootKey: "root-b" }]} skillCopies={loading} />),
    );
    expect(session.readProjectAttention("p1")).toBeUndefined();
    expect(container.textContent).toBe("null");
  } finally {
    act(() => root.unmount());
  }
});
