// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderExternal, openLibrary, click, openExternalSkill } from "./external-library-fixture";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T14:00:00.000Z"));
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it.each([
  ["fr", "vérifié aujourd'hui à"],
  ["en", "checked today at"],
] as const)("dates the library check without a false day-part caption in %s", async (language, caption) => {
  await renderExternal(root, { language });
  await openLibrary(container);
  expect(container.querySelector(".page-stage-heading")?.textContent).toContain(caption);
});

it.each([
  ["fr", "changé le 7 oct."],
  ["en", "changed on 7 Oct"],
] as const)("labels the skill change date independently of source HEAD in %s", async (language, caption) => {
  const fixture = await renderExternal(root, { language });
  fixture.primary.skills.find((skill) => skill.name === "fresh-tool")!.lastChangeAt = "2026-10-07T09:12:00.000Z";
  await openLibrary(container);
  await click(container, language === "fr" ? "Vérifier maintenant" : "Check now");
  await click(container, "mattpocock/skills");
  await openExternalSkill(container, "fresh-tool");
  const sheet = container.querySelector('[data-testid="external-skill-sheet"]')!;
  expect(sheet.querySelector(".canvas-sheet-header .sh-sub")?.textContent).toContain(caption);
  expect(sheet.querySelector(".sh-body")?.textContent).not.toContain("version aaaaaaa");
});

it.each([
  ["fr", "vérifié hier à"],
  ["en", "checked yesterday at"],
] as const)("keeps an older library check dated truthfully in %s", async (language, caption) => {
  vi.setSystemTime(new Date("2026-10-13T14:00:00.000Z"));
  await renderExternal(root, { language });
  await openLibrary(container);
  expect(container.querySelector(".page-stage-heading")?.textContent).toContain(caption);
});
