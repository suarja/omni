// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { layoutPageSections } from "../../src/renderer/canvas/pages/PageGraph";
import { SkillUseChips } from "../../src/renderer/canvas/pages/SkillUseChips";
import { I18nProvider } from "../../src/renderer/i18n";
import { useFixture } from "./external-library-fixture";

it("grows only the row containing dense wrapped project chips and retains the accepted columns", () => {
  const ordinary = { id: "ordinary", title: "review", kind: "skill" as const, meta: null, onOpen: () => {} };
  const dense = {
    ...ordinary,
    id: "dense",
    metadataLabels: Array.from({ length: 12 }, (_, index) => `Project ${index} with a long name`),
  };
  const graph = layoutPageSections([
    { id: "first", title: "first", nodes: [dense, ordinary, ordinary, ordinary, ordinary] },
    { id: "second", title: "second", nodes: [ordinary] },
  ]);
  expect(graph.tops[1]).toBeGreaterThan(308);
  expect(graph.nodeTops[0]![4]! - graph.nodeTops[0]![0]!).toBeGreaterThan(96);
  const plain = layoutPageSections([{ id: "plain", title: "plain", nodes: Array.from({ length: 8 }, () => ordinary) }]);
  expect(plain.nodeTops[0]![0]).toBe(98);
  expect(plain.nodeTops[0]![3]).toBe(98);
  expect(plain.nodeTops[0]![4]).toBe(194);
});

it("shows all project chips followed by a single shared state", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const uses = ["acme-workspace", "acme-web", "notes-app"].map((name, index) => ({
    ...useFixture(`use-${index}`, "up-to-date"),
    projectId: name,
    projectName: name,
  }));
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="en">
        <SkillUseChips uses={uses} />
      </I18nProvider>,
    ),
  );
  expect([...container.querySelectorAll(".project-chip.is-installed")].map((chip) => chip.textContent)).toEqual([
    "acme-workspace",
    "acme-web",
    "notes-app",
  ]);
  expect(container.querySelectorAll(".project-chip")).toHaveLength(4);
  expect(container.querySelector(".project-chip:last-child")?.textContent).toBe("up to date");
  await act(async () => root.unmount());
});

it("keeps distinct aliases and mixed unknown, modified and removed states honest", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const states = ["unknown", "modified", "removed"] as const;
  const uses = states.map((state) => ({
    ...useFixture(state, state),
    projectName: "acme-workspace",
    skillPath: "skills/shared",
  }));
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="en">
        <SkillUseChips uses={uses} />
      </I18nProvider>,
    ),
  );
  expect([...container.querySelectorAll(".project-chip.is-installed")].map((chip) => chip.textContent)).toEqual(
    states.map((state) => `acme-workspace · ${state}`),
  );
  for (const state of states) expect(container.querySelectorAll(`.project-chip.is-${state}`)).toHaveLength(1);
  await act(async () => root.unmount());
});

it("uses measured wrapped content to place following rows without overlap", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => ({
    id: `skill-${index}`,
    title: "skill",
    kind: "skill" as const,
    meta: null,
    onOpen: () => {},
  }));
  const graph = layoutPageSections([{ id: "section", title: "section", nodes }], 70, 18, new Map([["skill-1", 140]]));
  expect(graph.nodeTops[0]![4]! - graph.nodeTops[0]![1]!).toBe(164);
  expect(graph.layout.bounds.bottom).toBeGreaterThan(graph.nodeTops[0]![4]! + 72);
});
