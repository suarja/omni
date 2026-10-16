// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  renderExternal,
  openSourcePage,
  openExternalSkill,
  openExternalInstall,
  openLibrary,
  click,
} from "./external-library-fixture";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 12, 23, 30));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const sheet = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const reload = async (): Promise<void> => {
  await act(async () => window.dispatchEvent(new Event("focus")));
};

const times = [
  [12, 0, 5, "Ce matin à 00:05", "This morning at 00:05"],
  [12, 11, 59, "Ce matin à 11:59", "This morning at 11:59"],
  [12, 12, 0, "Cet après-midi à 12:00", "This afternoon at 12:00"],
  [12, 17, 59, "Cet après-midi à 17:59", "This afternoon at 17:59"],
  [12, 18, 0, "Ce soir à 18:00", "This evening at 18:00"],
  [11, 23, 59, "Hier à 23:59", "Yesterday at 23:59"],
  [10, 9, 12, "Le 10 oct. à 09:12", "On 10 Oct at 09:12"],
] as const;
for (const language of ["fr", "en"] as const) {
  it.each(times)(`dates an automatic pass honestly in ${language}: %s %s:%s`, async (day, hour, minute, fr, en) => {
    const { api } = await renderExternal(root, { language });
    const list = await api.listExternalSources();
    list.lastPass.finishedAt = new Date(2026, 9, day, hour, minute).toISOString();
    list.lastPass.updates![0]!.copiesUpdated = 1;
    api.listExternalSources.mockResolvedValue(list);
    await reload();
    await openLibrary(container);
    const callout = sheet("external-library-page").querySelector(".external-callout")!;
    expect(callout.textContent).toContain(language === "fr" ? fr : en);
    expect(callout.textContent).toContain(language === "fr" ? "Omni a mis à jour 1 copie" : "Omni updated 1 copy");
    expect(callout.textContent).not.toContain(language === "fr" ? "1 copies" : "1 copies");
  });
  it.each([1, 2])(
    `shows only a comparison warning when zero copies were updated in ${language} and %s wait`,
    async (count) => {
      const { api, primary } = await renderExternal(root, { language });
      const list = await api.listExternalSources();
      list.lastPass.updates![0]!.copiesUpdated = 0;
      api.listExternalSources.mockResolvedValue(list);
      if (count === 2) primary.uses.push({ ...primary.uses[0]!, id: "alias", skillKey: "alias" });
      await reload();
      await openLibrary(container);
      const callout = sheet("external-library-page").querySelector(".external-callout")!;
      expect(callout.classList.contains("is-warn")).toBe(true);
      expect(callout.textContent).toContain(
        language === "fr"
          ? `${count} copie${count === 1 ? "" : "s"} modifiée`
          : `${count} modified cop${count === 1 ? "y" : "ies"}`,
      );
      expect(callout.textContent).not.toContain(language === "fr" ? "mis à jour" : "updated");
      await click(callout, language === "fr" ? "Comparer" : "Compare");
      expect(sheet("canvas-review-sheet")).not.toBeNull();
    },
  );
  it(`hides the callout when zero copies were updated and none wait in ${language}`, async () => {
    const { api, primary } = await renderExternal(root, { language });
    const list = await api.listExternalSources();
    list.lastPass.updates = [];
    api.listExternalSources.mockResolvedValue(list);
    primary.uses = primary.uses.map((use) => ({ ...use, state: "up-to-date", sourceChanged: false }));
    await reload();
    await openLibrary(container);
    expect(sheet("external-library-page").querySelector(".external-callout")).toBeNull();
    expect(sheet("external-library-page").querySelector(".stage-note")?.textContent).toContain(
      language === "fr" ? "vérifié" : "checked",
    );
  });
}

it("distinguishes aliases of the same source skill in source, comparison and review rows", async () => {
  const { primary } = await renderExternal(root);
  primary.uses.push({ ...primary.uses[0]!, id: "alias-use", skillKey: "alias" });
  primary.skills[0]!.useIds.push("alias-use");
  // Count all uses, including an alias that does not itself wait for comparison.
  primary.uses.push({
    ...primary.uses[0]!,
    id: "current-alias",
    skillKey: "current-alias",
    state: "up-to-date",
    sourceChanged: false,
  });
  primary.skills[0]!.useIds.push("current-alias");
  await reload();
  await openLibrary(container);
  await openSourcePage(container);
  const labels = [...sheet("external-source-page").querySelectorAll(".project-chip.is-installed")].map(
    (chip) => chip.textContent,
  );
  expect(labels).toContain("notes-app · grill-me");
  expect(labels).toContain("notes-app · alias");
  expect(labels).toContain("notes-app · current-alias");
  expect(labels).toContain("notes-app");
  await click(container, "Comparer");
  expect(sheet("external-compare-list").textContent).toContain("notes-app · grill-me");
  expect(sheet("external-compare-list").textContent).toContain("notes-app · alias");
  await click(container, "À valider");
  expect(container.querySelector('[data-external-review="modified:grill-me"]')?.textContent).toContain(
    "notes-app · grill-me",
  );
  expect(container.querySelector('[data-external-review="modified:alias-use"]')?.textContent).toContain(
    "notes-app · alias",
  );
});
it("distinguishes a failed alias from another use of its source skill in review", async () => {
  const { primary } = await renderExternal(root);
  primary.uses.push({
    ...primary.uses[0]!,
    id: "alias-use",
    skillKey: "alias",
    lastAutomaticFailure: {
      sourceHead: "a".repeat(40),
      copyHash: "c".repeat(64),
      failedAt: new Date().toISOString(),
      reason: "Copy changed during apply",
    },
  });
  primary.skills[0]!.useIds.push("alias-use");
  await reload();
  await click(container, "À valider");
  expect(
    container.querySelector('[data-external-review="failure:alias-use"]')?.querySelector("small")?.textContent,
  ).toContain("notes-app · alias · alias · Copy changed");
});

it("uses yesterday across the local month boundary", async () => {
  vi.setSystemTime(new Date(2026, 10, 1, 0, 1));
  const { api } = await renderExternal(root);
  const list = await api.listExternalSources();
  list.lastPass.finishedAt = new Date(2026, 9, 31, 23, 59).toISOString();
  api.listExternalSources.mockResolvedValue(list);
  await reload();
  await openLibrary(container);
  expect(sheet("external-library-page").querySelector(".external-callout")?.textContent).toContain("Hier à 23:59");
});
it("does not warn about local-only modifications after a zero-update pass", async () => {
  const { api, primary } = await renderExternal(root);
  const list = await api.listExternalSources();
  list.lastPass.updates![0]!.copiesUpdated = 0;
  api.listExternalSources.mockResolvedValue(list);
  primary.uses = [{ ...primary.uses[0]!, sourceChanged: false }];
  await reload();
  await openLibrary(container);
  expect(sheet("external-library-page").querySelector(".external-callout")).toBeNull();
});
