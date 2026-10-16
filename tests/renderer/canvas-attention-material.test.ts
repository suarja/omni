// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";

const tokens = readFileSync("src/renderer/canvas/canvas-tokens.css", "utf8");
const material = readFileSync("src/renderer/canvas/canvas.css", "utf8").replace(/^@import[^;]+;/m, "");

function resolveToken(name: string): string {
  const value = tokens.match(new RegExp(`--${name}:\\s*([^;]+);`, "u"))?.[1];
  if (!value) throw new Error(`Missing canvas token: ${name}`);
  return value.trim();
}

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

test.each([
  ["copy-difference", "canvas-node-warning-edge"],
  ["local-change", "canvas-node-warning-edge"],
  ["unavailable", "canvas-unknown"],
])("inspecting a node preserves its %s attention contour", (attention, tone) => {
  const style = document.createElement("style");
  style.textContent = material.replace(/var\(--(canvas-node-warning-edge|canvas-unknown)\)/gu, (_match, name: string) =>
    resolveToken(name),
  );
  document.head.append(style);
  const node = document.createElement("div");
  node.className = "canvas-node-row";
  node.dataset.state = "observed";
  node.dataset.attention = attention;
  const expected = document.createElement("div");
  expected.style.border = `1px solid ${resolveToken(tone)}`;
  document.body.append(node, expected);

  expect(getComputedStyle(node).borderTopColor).toBe(getComputedStyle(expected).borderTopColor);
  node.classList.add("is-inspected");
  expect(getComputedStyle(node).borderTopColor).toBe(getComputedStyle(expected).borderTopColor);
});
