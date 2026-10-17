import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/renderer/styles.css", "utf8");

function readRule(selector: string, css = styles): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `Missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start) + 1);
}

function readRendererFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? readRendererFiles(path) : [path];
  });
}

describe("native window edges", () => {
  it("fills the native window without painting a border or rounded frame", () => {
    const shell = readRule(".app-shell");
    expect(shell).toContain("inset: 0;");
    expect(shell).not.toMatch(/border(?:-radius)?:/);
  });

  it("removes all painted-frame tokens from every renderer file", () => {
    const leftovers = readRendererFiles("src/renderer").filter((path) =>
      readFileSync(path, "utf8").includes("--window-frame-"),
    );
    expect(leftovers).toEqual([]);
  });

  it("uses the same theme-independent surface for the body, shell and native launch background", () => {
    expect(styles).toContain("--app-surface: #f7f8f6;");
    for (const selector of [":root", "body", ".app-shell"]) {
      expect(readRule(selector)).toContain("background: var(--app-surface);");
    }
    expect(readFileSync("src/main/index.ts", "utf8")).toContain('backgroundColor: "#f7f8f6"');
  });

  it("keeps non-canvas content on its existing theme palette", () => {
    expect(readRule(".content-area")).toContain("background: var(--color-canvas);");
    const canvas = readFileSync("src/renderer/canvas/canvas.css", "utf8");
    expect(readRule(".content-area--canvas", canvas)).toContain("background: var(--canvas-paper);");
  });

  it("covers the content below the native controls without frame offsets or outer radii", () => {
    const backdrop = readRule(".drawer-backdrop");
    expect(backdrop).toContain("inset: var(--titlebar-height) 0 0;");
    expect(backdrop).not.toContain("border-radius:");
    const canvas = readRule(".resource-canvas", readFileSync("src/renderer/canvas/canvas.css", "utf8"));
    expect(canvas).toContain("inset: 0;");
    expect(canvas).not.toContain("border-radius:");
    expect(styles).toContain("--titlebar-height: 52px;");
    const lesson = readRule(".academy-lesson-panel", readFileSync("src/renderer/learn/learn.css", "utf8"));
    expect(lesson).toContain("top: var(--titlebar-height); right: 0; bottom: 0;");
    expect(lesson).not.toContain("border-radius:");
  });
});
