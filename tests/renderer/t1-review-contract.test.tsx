// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { CanvasGlyph, type CanvasGlyphName } from "../../src/renderer/canvas/CanvasGlyph";
import { canvasNodeMetadata } from "../../src/renderer/canvas/canvas-node-metadata";
import { t } from "../../src/renderer/i18n";
import { projectSnapshot, projectId, skills } from "./project-view-fixture";
import type { ManagedSkillUse } from "../../src/domain/skill-reconciliation/types";

const prototype = readFileSync("tests/fixtures/canvas-contract.html", "utf8");
const translate = (key: Parameters<typeof t>[0], values?: Parameters<typeof t>[1]): string =>
  t(key, values ?? {}, "fr");

it.each(["marketplace", "external", "project", "skill", "doc", "group", "warn"] as const)(
  "uses the exact prototype %s glyph",
  (name) => {
    const svg = prototype.match(new RegExp(`  ${name}: '(<svg[^']+)',`))![1];
    compareGlyph(name, svg, 18);
  },
);
it.each([
  ["home", 'data-nav="workspace"'],
  ["review", 'data-sheet="inbox"'],
  ["activity", 'data-sheet="history"'],
  ["settings", 'data-sheet="settings"'],
] as const)("uses the exact prototype %s rail glyph at 20 pixels", (name, attribute) => {
  const svg = prototype.match(new RegExp(`${attribute}[^\\n]+?(<svg[^\\n]+?</svg>)`))![1];
  compareGlyph(name, svg, 20);
});
function compareGlyph(name: CanvasGlyphName, source: string, size: number): void {
  const actual = document.createElement("div");
  const expected = document.createElement("div");
  actual.innerHTML = renderToStaticMarkup(<CanvasGlyph name={name} size={size} />);
  expected.innerHTML = source;
  expect(actual.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(actual.querySelector("svg")?.getAttribute("stroke-width")).toBe("1.7");
  expect(actual.querySelector("svg")?.getAttribute("width")).toBe(String(size));
  expect(actual.querySelector("svg")?.getAttribute("height")).toBe(String(size));
  expect(actual.querySelector("svg")?.innerHTML).toBe(expected.querySelector("svg")?.innerHTML);
}
it("uses only semantic palette tokens in the corrected canvas styles", () => {
  const files = [
    "canvas-tokens.css",
    "canvas.css",
    "project-view.css",
    "skill-copies.css",
    "changes/changes.css",
    "changes/copy-management.css",
    "changes/workflow.css",
    "changes/propagation/propagation.css",
    "spatial/spatial.css",
  ];
  const tokens = readFileSync("src/renderer/canvas/canvas-tokens.css", "utf8");
  for (const file of files) {
    const css = readFileSync(`src/renderer/canvas/${file}`, "utf8");
    expect(css).not.toMatch(/--canvas-color-/);
    if (file !== "canvas-tokens.css") expect(css).not.toMatch(/#[a-f\d]{3,8}\b/i);
    for (const [, token] of css.matchAll(/var\((--canvas-[\w-]+)\)/g))
      expect(`${tokens}\n${css}`).toContain(`${token}:`);
  }
});
it("counts managed skills once across agents without reading an unobserved root", () => {
  const snapshot = {
    ...projectSnapshot,
    roots: projectSnapshot.roots.map((root) => ({ ...root, evidence: { status: "unobserved" as const } })),
  };
  const use: ManagedSkillUse = {
    skillId: "skill-one",
    bindingId: "binding-one",
    location: { projectId, harnessId: "claude-code", folderPath: ".claude/skills/one" },
    source: { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/one" },
    baseRevisionId: "revision-one",
  };
  const metadata = canvasNodeMetadata(snapshot, translate, [
    use,
    { ...use, bindingId: "binding-two", location: { ...use.location, harnessId: "codex" } },
  ]);
  expect(metadata.get(JSON.stringify({ kind: "entry", entry: { kind: "project", id: projectId } }))).toBe(
    "1 de ma marketplace",
  );
  const source = projectSnapshot.registry.sources.find((source) => source.ownership === "personal")!;
  expect(metadata.get(JSON.stringify({ kind: "entry", entry: source.ref }))).toBe("Pas encore lu");
});

it("keeps unknown counters explicit even when registry roots have no observation entry", () => {
  const metadata = canvasNodeMetadata({ ...projectSnapshot, roots: [] }, translate);
  for (const record of [...projectSnapshot.registry.projects, ...projectSnapshot.registry.sources]) {
    expect(metadata.get(JSON.stringify({ kind: "entry", entry: record.ref }))).toBe("Pas encore lu");
  }
});

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});
it("keeps the confirmation, controls and underlying sheet fully opaque", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/renderer/canvas/project-view.css", "utf8").replace(/^@import[^;]+;/m, "");
  document.head.append(style);
  const canvas = document.createElement("div");
  canvas.className = "resource-canvas";
  canvas.innerHTML =
    '<div class="project-sheet-layer" inert><section class="sheet"><button disabled>Underlying control</button></section></div><div class="canvas-pop project-confirmation"><button>Cancel</button><button disabled>Pending action</button></div>';
  document.body.append(canvas);
  for (const element of canvas.querySelectorAll(
    ".sheet, .sheet button, .project-confirmation, .project-confirmation button",
  ))
    expect(getComputedStyle(element).opacity).toBe("1");
});

it.each([false, true])("prefers the session project total over older inventory (observed=%s)", (observed) => {
  const metadata = canvasNodeMetadata(
    observed ? projectSnapshot : { ...projectSnapshot, roots: [] },
    translate,
    [],
    [{ ...skills, projectId }],
  );
  expect(metadata.get(JSON.stringify({ kind: "entry", entry: { kind: "project", id: projectId } }))).toBe("4 skills");
});
