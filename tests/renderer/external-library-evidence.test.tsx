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
  comparisonFixture,
  type FixtureOptions,
} from "./external-library-fixture";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});
const sheet = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
async function source(options: FixtureOptions = {}): Promise<Awaited<ReturnType<typeof renderExternal>>> {
  const fixture = await renderExternal(root, options);
  await openLibrary(container);
  await openSourcePage(container);
  return fixture;
}
async function compare(options: FixtureOptions = {}): Promise<Awaited<ReturnType<typeof renderExternal>>> {
  const fixture = await source(options);
  await click(container, "Comparer");
  await click(sheet("external-compare-list"), "Comparer");
  return fixture;
}
async function install(skillName: string): Promise<void> {
  await openExternalInstall(container, skillName);
}

async function refreshEvidence(): Promise<void> {
  await act(async () => window.dispatchEvent(new Event("focus")));
}
function updateAction(): HTMLButtonElement {
  return [...sheet("external-update-sheet").querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.startsWith("Mettre à jour ("),
  )!;
}
it.each(["copyHash", "sourceHash", "lockHash", "installedCommit", "skillPath"] as const)(
  "requires a fresh file decision after the compared %s changes",
  async (field) => {
    const { api, primary } = await compare();
    await click(container, "Garder le mien");
    const previews = api.previewSkillOperation.mock.calls.length;
    const use = primary.uses[0]!;
    if (field === "installedCommit") use[field] = "e".repeat(40);
    else if (field === "skillPath") use[field] = "skills/new-copy";
    else use[field] = "e".repeat(64);
    await refreshEvidence();
    expect(sheet("external-update-sheet").querySelector('button[aria-pressed="true"]')).toBeNull();
    expect(updateAction().disabled).toBe(true);
    expect(api.previewSkillOperation).toHaveBeenCalledTimes(previews);
    expect(sheet("external-update-sheet").querySelector("details.external-section")).toBeNull();
    await click(container, "Garder le mien");
    expect(updateAction().disabled).toBe(false);
    expect(api.previewSkillOperation).toHaveBeenCalledTimes(previews + 1);
  },
);
it("preserves an unaffected use's decision when another copy changes", async () => {
  const { api, primary } = await compare({ twoProjects: true });
  await click(container, "Garder le mien");
  const targets = sheet("external-update-sheet").querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => targets[1]!.click());
  await click(
    sheet("external-update-sheet").querySelector<HTMLElement>('[data-use-id="grill-other"]')!,
    "Prendre la source",
  );
  primary.uses[0]!.copyHash = "e".repeat(64);
  await refreshEvidence();
  expect(
    sheet("external-update-sheet").querySelector('[data-use-id="grill-me"] button[aria-pressed="true"]'),
  ).toBeNull();
  expect(
    sheet("external-update-sheet").querySelector('[data-use-id="grill-other"] button[aria-pressed="true"]')
      ?.textContent,
  ).toBe("Prendre la source");
  expect(updateAction().disabled).toBe(true);
  await act(async () =>
    sheet("external-update-sheet").querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  expect(updateAction().disabled).toBe(false);
  expect(api.previewSkillOperation).toHaveBeenLastCalledWith(
    expect.objectContaining({ intent: expect.objectContaining({ useId: "grill-other" }) }),
  );
});
it.each(["head", "readCopy", "base"] as const)(
  "clears whole-copy decisions when %s evidence changes",
  async (field) => {
    const { api, primary } = await compare({ missingBase: true });
    await click(container, "Garder ma copie");
    const previews = api.previewSkillOperation.mock.calls.length;
    if (field === "head") primary.source!.head!.commit = "e".repeat(40);
    else if (field === "readCopy") primary.source!.readCopy = "/new/read-copy";
    else primary.uses[0]!.base = { status: "not-found", scanned: 50, bounded: true, reason: "timeout" };
    await refreshEvidence();
    expect(sheet("external-update-sheet").querySelector('button[aria-pressed="true"]')).toBeNull();
    expect(updateAction().disabled).toBe(true);
    expect(api.previewSkillOperation).toHaveBeenCalledTimes(previews);
  },
);
it.each(["recovered", "unknown", "bounded"] as const)(
  "clears a missing-base choice when a refreshed comparison becomes %s with unchanged hashes",
  async (state) => {
    const { api } = await compare({ missingBase: true });
    await click(container, "Prendre la version de la source");
    const previews = api.previewSkillOperation.mock.calls.length;
    api.compareExternalUse.mockImplementation(async ({ useId }) =>
      state === "recovered"
        ? comparisonFixture(useId)
        : {
            status: "unavailable",
            useId,
            files: [],
            base:
              state === "unknown"
                ? { status: "unknown", reason: "History unavailable" }
                : { status: "not-found", scanned: 20, bounded: true, reason: "timeout" },
          },
    );
    await refreshEvidence();
    expect(sheet("external-update-sheet").querySelector('button[aria-pressed="true"]')).toBeNull();
    expect(updateAction().disabled).toBe(true);
    expect(api.previewSkillOperation).toHaveBeenCalledTimes(previews);
  },
);
it("keeps a healthy selected comparison usable when an unselected project's comparison fails", async () => {
  const { api } = await source({ twoProjects: true });
  const original = api.compareExternalUse.getMockImplementation()!;
  api.compareExternalUse.mockImplementation(async (request) => {
    if (request.useId === "grill-other") throw new Error("Other project comparison failed");
    return original(request);
  });
  await click(container, "Comparer");
  await click(sheet("external-compare-list"), "Comparer");
  const failing = sheet("external-update-sheet").querySelector('[data-use-id="grill-other"]')!;
  expect(failing.querySelector('[role="alert"]')?.textContent).toBe("Other project comparison failed");
  await click(container, "Garder le mien");
  expect(updateAction().disabled).toBe(false);
  const targets = sheet("external-update-sheet").querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => targets[1]!.click());
  expect(updateAction().disabled).toBe(true);
  await act(async () => targets[1]!.click());
  expect(updateAction().disabled).toBe(false);
  expect(api.previewSkillOperation).toHaveBeenLastCalledWith(
    expect.objectContaining({ intent: expect.objectContaining({ useId: "grill-me" }) }),
  );
});
it("keeps successful installation reads when an unrelated project is inaccessible", async () => {
  const { api, primary } = await source();
  const healthyId = primary.uses[0]!.projectId;
  const original = api.readProjectSkills.getMockImplementation()!;
  api.readProjectSkills.mockImplementation(async (id) => {
    if (id !== healthyId) throw new Error("Other project read failed");
    return original(id);
  });
  await install("fresh-tool");
  const targets = sheet("external-install-sheet").querySelectorAll<HTMLInputElement>(".external-options input");
  expect(targets[0]!.disabled).toBe(false);
  expect(targets[1]!.disabled).toBe(true);
  expect(targets[1]!.closest("label")?.querySelector('[role="alert"]')?.textContent).toBe("Other project read failed");
  expect(targets[0]!.checked).toBe(true);
  expect(api.previewSkillOperation).toHaveBeenLastCalledWith({
    intent: expect.objectContaining({
      kind: "install-external-skill",
      targets: [{ projectId: healthyId, harnessIds: ["claude-code", "codex"] }],
    }),
  });
  expect(
    [...sheet("external-install-sheet").querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Installer",
    )!.disabled,
  ).toBe(false);
});
