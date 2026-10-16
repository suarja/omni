// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const tokens = readFileSync("src/renderer/canvas/canvas-tokens.css", "utf8");
const material = readFileSync("src/renderer/canvas/canvas.css", "utf8").replace(/^@import[^;]+;/m, "");
const spatial = readFileSync("src/renderer/canvas/spatial/spatial.css", "utf8");
const prototype = readFileSync("tests/fixtures/canvas-contract.html", "utf8");
const reference = prototype.match(/<style>([\s\S]*?)<\/style>/)![1];

// jsdom does not resolve custom properties; expand the contract before comparing computed styles.
function resolveTokens(css: string, definitions: string): string {
  const values = new Map(
    [...definitions.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)].map((match) => [match[1], match[2]]),
  );
  for (let pass = 0; pass < 10; pass++) {
    const next = css.replace(
      /var\((--[\w-]+)(?:,\s*([^()]+))?\)/g,
      (expression, name: string, fallback: string | undefined) => values.get(name) ?? fallback ?? expression,
    );
    if (next === css) break;
    css = next;
  }
  return css;
}
const actualStyles = resolveTokens(material, tokens);
const referenceStyles = resolveTokens(reference, reference);
const sheets = readFileSync("src/renderer/canvas/sheet-frame.css", "utf8");
const legacyUi = [
  "src/renderer/components/ui/ui.css",
  "src/renderer/components/ui/surfaces.css",
  "src/renderer/styles.css",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

function renderNode(styles: readonly string[], kind = "project"): HTMLElement {
  for (const css of styles) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  }
  const row = document.createElement("div");
  row.className = "canvas-node-row is-center";
  row.dataset.kind = kind;
  document.body.append(row);
  return row;
}

function compareNodeParts(): Readonly<{ actual: HTMLElement; expected: HTMLElement }> {
  const actual = renderNode([spatial, actualStyles, referenceStyles], "artifact");
  actual.dataset.state = "observed";
  actual.innerHTML =
    '<button class="canvas-node" data-kind="artifact" data-state="observed"><span class="canvas-node-icon"></span><span class="canvas-node-label">Two line label</span></button><button class="canvas-node-info"></button>';
  const expected = document.createElement("div");
  expected.className = "node center";
  expected.innerHTML =
    '<span class="tile"></span><span class="ntitle">Two line label</span><button class="ninfo"></button>';
  document.body.append(expected);
  return { actual, expected };
}

describe("UX pass 2 canvas material", () => {
  it("uses one sheet geometry and replaces nested card borders with hairline rows", () => {
    const style = document.createElement("style");
    style.textContent = resolveTokens(`${legacyUi}\n${material}\n${sheets}`, tokens);
    document.head.append(style);
    const sheet = document.createElement("section");
    sheet.className = "sheet canvas-sheet";
    sheet.innerHTML =
      '<header class="sh-head"><h2 class="sh-title">Settings</h2></header><div class="sh-body"><section class="ui-card"><div class="ui-item-list"><div class="ui-item">Agent</div></div></section><button class="ui-button ui-button--primary ui-button--small">Open</button></div><footer class="sh-foot">Footer</footer>';
    document.body.append(sheet);
    expect(getComputedStyle(sheet).width).toBe("520px");
    expect(getComputedStyle(sheet).borderRadius).toBe("14px");
    expect(getComputedStyle(sheet.querySelector(".sh-head")!).padding).toBe("16px 18px 0px");
    const body = getComputedStyle(sheet.querySelector(".sh-body")!);
    expect(body.padding).toBe("16px 18px 18px");
    expect(body.marginTop).toBe("12px");
    expect(body.borderTopWidth).toBe("1px");
    expect(getComputedStyle(sheet.querySelector(".sh-foot")!).padding).toBe("12px 18px");
    expect(getComputedStyle(sheet.querySelector(".sh-title")!).letterSpacing).toBe("normal");
    expect(getComputedStyle(sheet.querySelector(".ui-card")!).borderTopWidth).toBe("0px");
    const row = getComputedStyle(sheet.querySelector(".ui-item")!);
    expect(row.padding).toBe("11px 4px");
    expect(row.borderBottomWidth).toBe("1px");
    expect(row.borderLeftWidth).toBe("0px");
    expect(row.boxShadow).toBe("none");
    const button = getComputedStyle(sheet.querySelector(".ui-button")!);
    expect(button.minHeight).toBe("28px");
    expect(button.padding).toBe("0px 9px");
    expect(button.borderRadius).toBe("8px");
    expect(button.backgroundColor).toBe("rgb(46, 52, 56)");
  });

  it("matches normative node dimensions, spacing and reserved info-button space", () => {
    const { actual, expected } = compareNodeParts();
    for (const property of ["width", "min-height", "border-radius"]) {
      expect(getComputedStyle(actual).getPropertyValue(property)).toBe(
        getComputedStyle(expected).getPropertyValue(property),
      );
    }
    const main = getComputedStyle(actual.querySelector(".canvas-node")!);
    for (const property of ["padding-left", "padding-top", "padding-bottom", "gap"]) {
      expect(main.getPropertyValue(property)).toBe(getComputedStyle(expected).getPropertyValue(property));
    }
    const info = getComputedStyle(actual.querySelector(".canvas-node-info")!);
    expect(
      parseFloat(main.paddingRight) +
        parseFloat(info.width) +
        parseFloat(info.marginLeft) +
        parseFloat(info.marginRight),
    ).toBe(parseFloat(getComputedStyle(expected).paddingRight));
    for (const [actualClass, expectedClass, properties] of [
      ["canvas-node-label", "ntitle", ["line-height", "overflow-wrap"]],
      ["canvas-node-icon", "tile", ["width", "height", "border-radius"]],
      ["canvas-node-info", "ninfo", ["width", "height", "border-radius"]],
    ] as const) {
      for (const property of properties) {
        expect(getComputedStyle(actual.querySelector(`.${actualClass}`)!).getPropertyValue(property)).toBe(
          getComputedStyle(expected.querySelector(`.${expectedClass}`)!).getPropertyValue(property),
        );
      }
    }
  });

  it("uses the prototype's skill tone and twelve-percent icon tint", () => {
    expect(tokens).toContain("--canvas-skill: #997535;");
    expect(material).toContain("background: color-mix(in srgb, var(--canvas-node-tone) 12%, var(--canvas-surface))");
    expect(reference).toContain("background:color-mix(in srgb,var(--tone) 12%,#fff)");
  });

  it("matches the normative selected contour and relief", () => {
    const { actual, expected } = compareNodeParts();
    actual.classList.add("is-inspected");
    expect(getComputedStyle(actual).borderTopColor).toBe(getComputedStyle(expected).borderTopColor);
    expect(getComputedStyle(actual).boxShadow.replace(/\s+/g, "")).toBe(
      getComputedStyle(expected).boxShadow.replace(/\s+/g, ""),
    );
  });

  it.each([
    ["spatial first", [spatial, actualStyles]],
    ["material first", [actualStyles, spatial]],
  ] as const)("anchors nodes to world coordinates with %s", (_name, styles) => {
    const computed = getComputedStyle(renderNode(styles));
    expect(computed.position).toBe("absolute");
    expect(computed.zIndex).toBe("1");
  });

  it.each(["project", "group"])("marks the central %s with the normative hierarchy contour", (kind) => {
    const computed = getComputedStyle(renderNode([spatial, actualStyles], kind));
    expect(computed.borderTopColor).toBe("rgb(201, 211, 226)");
  });
});

function readInheritedFontFamily(element: Element): string {
  let current: Element | null = element;
  while (current) {
    const family = getComputedStyle(current).fontFamily;
    if (family && family !== "inherit") return family;
    current = current.parentElement;
  }
  return "";
}
it("uses the system face for every stage heading control while keeping the title in Georgia", () => {
  const style = document.createElement("style");
  const project = readFileSync("src/renderer/canvas/project-view.css", "utf8").replace(/^@import[^;]+;/m, "");
  style.textContent = resolveTokens(
    `${tokens}\nbutton, input, select { font: inherit; }\n${material}\n${project}`,
    tokens,
  );
  document.head.append(style);
  const canvas = document.createElement("div");
  canvas.className = "resource-canvas";
  canvas.innerHTML =
    '<div class="project-stage-heading"><strong class="stage-title">notes-app</strong><span class="canvas-glossary"><button class="canvas-glossary-trigger">Info</button></span><button class="canvas-secondary-button is-small is-primary">Manage skills</button><input aria-label="Filter"><select aria-label="Agent"><option>Codex</option></select></div>';
  document.body.append(canvas);
  expect(readInheritedFontFamily(canvas.querySelector(".stage-title")!)).toBe("Georgia, serif");
  for (const control of canvas.querySelectorAll("button, input, select")) {
    expect(readInheritedFontFamily(control)).toContain("-apple-system");
    expect(readInheritedFontFamily(control)).not.toContain("Georgia");
  }
});
it("keeps toolbar search on one body-sized line with a content-sized width and right-aligned shortcut", () => {
  const style = document.createElement("style");
  style.textContent = actualStyles;
  document.head.append(style);
  const canvas = document.createElement("div");
  canvas.innerHTML =
    '<button class="canvas-search-trigger"><span>Rechercher un skill, un projet</span><kbd>⌘K</kbd></button>';
  document.body.append(canvas);
  const search = getComputedStyle(canvas.querySelector("button")!);
  expect(search.whiteSpace).toBe("nowrap");
  expect(search.minWidth).toBe("240px");
  expect(search.width).toBe("max-content");
  expect(search.flexShrink).toBe("0");
  expect(search.fontSize).toBe("15px");
  expect(getComputedStyle(canvas.querySelector("kbd")!).marginLeft).toBe("auto");
});
