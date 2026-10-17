// @vitest-environment jsdom
import { act, useLayoutEffect, useRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasViewport } from "../../src/renderer/canvas/spatial/CanvasViewport";
import { useCanvasCamera } from "../../src/renderer/canvas/spatial/use-canvas-camera";
import { fitCamera } from "../../src/renderer/canvas/spatial/camera";
import type { Camera, CanvasLayout } from "../../src/renderer/canvas/spatial/spatial-types";
import { I18nProvider } from "../../src/renderer/i18n";
import { buildProjectGraph } from "../../src/renderer/canvas/project-graph-layout";
import type { ProjectInstructions } from "../../src/renderer/canvas/project-view-model";

const layout: CanvasLayout = {
  nodes: [],
  wires: [],
  ports: [],
  bounds: { left: -528, top: -180, right: 528, bottom: 332 },
};
let root: Root;
let container: HTMLDivElement;
let width: number;
let height: number;
let resize: () => void;
let paints: { visibility: string; transform: string }[];
const changed = vi.fn();

function Harness(props: { viewKey?: string; layout?: CanvasLayout; initialCamera?: Camera }): ReactElement {
  const viewportRef = useRef<HTMLDivElement>(null);
  const controls = useCanvasCamera({
    viewportRef,
    viewKey: props.viewKey ?? "workspace",
    layout: props.layout ?? layout,
    initialCamera: props.initialCamera,
    disabled: false,
    onCameraChange: changed,
  });
  useLayoutEffect(() => {
    const world = container.querySelector<HTMLElement>(".canvas-world")!;
    paints.push({ visibility: world.style.visibility, transform: world.style.transform });
  });
  return (
    <CanvasViewport viewportRef={viewportRef} controls={controls} disabled={false}>
      <button>Node</button>
    </CanvasViewport>
  );
}
function render(props: Parameters<typeof Harness>[0] = {}): void {
  act(() =>
    root.render(
      <I18nProvider initialLanguage="en">
        <Harness {...props} />
      </I18nProvider>,
    ),
  );
}
function transform(): string {
  return container.querySelector<HTMLElement>(".canvas-world")!.style.transform;
}

beforeEach(() => {
  width = 1200;
  height = 760;
  paints = [];
  changed.mockClear();
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  vi.spyOn(HTMLDivElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLDivElement.prototype, "clientHeight", "get").mockImplementation(() => height);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["workspace", "project", "marketplace", "external"])("never exposes an unfitted %s world", (viewKey) => {
  render({ viewKey });
  const camera = fitCamera(layout.bounds, { width, height });
  const expected = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  expect(paints.filter((paint) => paint.visibility !== "hidden").map((paint) => paint.transform)).toEqual([expected]);
  expect(transform()).toBe(expected);
});

it("keeps the world hidden until a positive viewport measurement", () => {
  width = 0;
  height = 0;
  render();
  const world = container.querySelector<HTMLElement>(".canvas-world")!;
  expect(world.style.visibility).toBe("hidden");
  expect(world.style.opacity).toBe("0");
  expect(world.hidden).toBe(false);
  expect(world.hasAttribute("inert")).toBe(true);
  width = 1200;
  height = 760;
  act(() => resize());
  expect(paints.filter((paint) => paint.visibility !== "hidden")).toHaveLength(1);
});

it("does not reinitialize the visit when late data or a saved-camera echo arrives", () => {
  render();
  const first = transform();
  const larger = { ...layout, bounds: { ...layout.bounds, bottom: 900 } };
  render({ layout: larger, initialCamera: { x: 12, y: 34, scale: 0.5 } });
  expect(transform()).toBe(first);
  expect(changed).toHaveBeenCalledTimes(1);
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Fit canvas"]')!.click());
  expect(transform()).not.toBe(first);
});

it("initializes each new visit before revealing it and restores its supplied camera", () => {
  render();
  paints = [];
  render({ viewKey: "project", initialCamera: { x: 42, y: 64, scale: 1.2 } });
  expect(
    paints
      .filter((paint) => paint.visibility !== "hidden")
      .every((paint) => paint.transform === "translate(42px, 64px) scale(1.2)"),
  ).toBe(true);
  render({ viewKey: "workspace" });
  expect(changed).toHaveBeenCalledTimes(3);
});

it("keeps the project fit and existing nodes in place when instruction files arrive", () => {
  const t = ((key: string, values?: Record<string, unknown>) => `${key}:${values?.name ?? ""}`) as Parameters<
    typeof buildProjectGraph
  >[4];
  const before = buildProjectGraph(null, "Project", null, [], t);
  const instructions: ProjectInstructions[] = ["AGENTS.md", "CLAUDE.md"].map((path) => ({
    path,
    aliases: [],
    agents: [],
  }));
  const after = buildProjectGraph(null, "Project", null, instructions, t);
  expect(after.layout.bounds).toEqual(before.layout.bounds);
  for (const node of before.nodes)
    expect(after.nodes.find((next) => next.id === node.id)).toMatchObject({ x: node.x, y: node.y });
  render({ layout: before.layout });
  const first = transform();
  render({ layout: after.layout });
  expect(transform()).toBe(first);
});

it("reserves each primary instruction slot even when CLAUDE.md arrives before AGENTS.md", () => {
  const t = ((key: string, values?: Record<string, unknown>) => `${key}:${values?.name ?? ""}`) as Parameters<
    typeof buildProjectGraph
  >[4];
  const claude = { path: "CLAUDE.md", aliases: [], agents: [] };
  const agents = { path: "AGENTS.md", aliases: [], agents: [] };
  const before = buildProjectGraph(null, "Project", null, [claude], t);
  const after = buildProjectGraph(null, "Project", null, [agents, claude], t);
  const instruction = before.nodes.find((node) => node.concept === "instructions")!;
  expect(after.nodes.find((node) => node.title === instruction.title && node.id === instruction.id)).toMatchObject({
    x: instruction.x,
    y: instruction.y,
  });
  const overflow = buildProjectGraph(null, "Project", null, [agents, claude, { ...agents, path: "GEMINI.md" }], t);
  expect(new Set(overflow.nodes.filter((node) => node.x === 396).map((node) => node.y)).size).toBe(4);
  expect(overflow.nodes.find((node) => node.id === "cost")?.y).toBe(after.nodes.find((node) => node.id === "cost")?.y);
});
