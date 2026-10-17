// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Skeleton, LoadingSkeleton, LoadingBoundary } from "../../src/renderer/components/ui/Skeleton";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
it("reserves rows immediately and reveals skeletons only after 150 ms", () => {
  act(() => root.render(<LoadingSkeleton label="Loading projects" />));
  const placeholder = container.querySelector("[aria-busy='true']")!;
  expect(placeholder.getAttribute("aria-label")).toBe("Loading projects");
  expect(placeholder.getAttribute("data-visible")).toBe("false");
  expect(container.querySelectorAll(".ui-skeleton-row")).toHaveLength(3);
  act(() => vi.advanceTimersByTime(149));
  expect(placeholder.getAttribute("data-visible")).toBe("false");
  act(() => vi.advanceTimersByTime(1));
  expect(placeholder.getAttribute("data-visible")).toBe("true");
});
it("keeps the same reserved container when content replaces loading", () => {
  const render = (loading: boolean): void => {
    act(() =>
      root.render(
        <LoadingBoundary loading={loading} label="Loading projects" minHeight={216}>
          <div>Projects</div>
        </LoadingBoundary>,
      ),
    );
  };
  render(true);
  const frame = container.firstElementChild as HTMLElement;
  expect(frame.style.minHeight).toBe("216px");
  act(() => vi.advanceTimersByTime(150));
  render(false);
  expect(container.firstElementChild).toBe(frame);
  expect(frame.style.minHeight).toBe("216px");
  expect(frame.textContent).toBe("Projects");
  expect(frame.querySelector(".ui-skeleton")).toBeNull();
});
it("keeps received content visible during background refresh", () => {
  act(() =>
    root.render(
      <LoadingBoundary loading={false} label="Loading projects">
        <div>Received project</div>
      </LoadingBoundary>,
    ),
  );
  act(() =>
    root.render(
      <LoadingBoundary loading label="Loading projects">
        <div>Received project</div>
      </LoadingBoundary>,
    ),
  );
  act(() => vi.advanceTimersByTime(150));
  expect(container.textContent).toContain("Received project");
  expect(container.querySelector(".ui-skeleton")).toBeNull();
});
it("supports block, line and circle shapes with one motion policy", () => {
  act(() =>
    root.render(
      <>
        <Skeleton />
        <Skeleton shape="line" />
        <Skeleton shape="circle" />
      </>,
    ),
  );
  expect(container.querySelectorAll("[aria-hidden='true']")).toHaveLength(3);
  const css = readFileSync("src/renderer/components/ui/skeleton.css", "utf8");
  expect(css).toMatch(/animation: ui-skeleton-shimmer 1\.4s/);
  expect(css).toMatch(/@media\s*\(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
  expect(css).toContain("--canvas-sheet-inset");
  expect(css).toContain("--canvas-sheet-edge");
});
it("cancels delayed placeholders for fast loads and after unmount", () => {
  act(() => root.render(<LoadingSkeleton label="Loading projects" />));
  act(() => vi.advanceTimersByTime(100));
  act(() => root.render(<div>Projects</div>));
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(100));
  expect(container.textContent).toBe("Projects");
});
it("retains the last completed list while its host supplies a loading fallback", () => {
  act(() =>
    root.render(
      <LoadingBoundary loading={false} label="Loading projects">
        <div>Received project</div>
      </LoadingBoundary>,
    ),
  );
  act(() =>
    root.render(
      <LoadingBoundary loading label="Loading projects">
        <LoadingSkeleton label="Loading projects" />
      </LoadingBoundary>,
    ),
  );
  act(() => vi.advanceTimersByTime(150));
  expect(container.textContent).toBe("Received project");
  expect(container.querySelector(".ui-skeleton")).toBeNull();
});
it("reserves caller-owned card geometry throughout the loading delay", () => {
  act(() =>
    root.render(
      <LoadingSkeleton
        label="Loading Academy"
        shapes={
          <div className="academy-course-card">
            <Skeleton height={144} />
          </div>
        }
      />,
    ),
  );
  expect(container.querySelector(".academy-course-card")).not.toBeNull();
  expect(container.querySelector("[data-visible]")?.getAttribute("data-visible")).toBe("false");
  act(() => vi.advanceTimersByTime(150));
  expect(container.querySelector(".academy-course-card")).not.toBeNull();
});
