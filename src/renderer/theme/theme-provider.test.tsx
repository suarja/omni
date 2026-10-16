// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrapTheme, ThemeProvider, useTheme } from "./theme-provider";

function ThemeProbe(): ReactElement {
  const { mode, setMode, toggleTheme } = useTheme();

  return (
    <div>
      <output data-testid="mode">{mode}</output>
      <button type="button" onClick={() => setMode("dark")}>
        Set dark
      </button>
      <button type="button" onClick={toggleTheme}>
        Toggle
      </button>
    </div>
  );
}

function renderThemeProbe(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
  });
  return { container, root };
}

function click(button: HTMLButtonElement): void {
  act(() => {
    button.click();
  });
}

describe("ThemeProvider", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;
  let localStorageDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      } satisfies Pick<Storage, "clear" | "getItem" | "setItem">,
    });
    window.localStorage.clear();
    document.documentElement.dataset.theme = "";
    document.body.replaceChildren();
  });

  afterEach(() => {
    act(() => {
      rendered?.root.unmount();
    });
    rendered?.container.remove();
    rendered = undefined;
    vi.restoreAllMocks();
    if (localStorageDescriptor) {
      Object.defineProperty(window, "localStorage", localStorageDescriptor);
    }
    localStorageDescriptor = undefined;
  });

  it("defaults to light and applies the document theme", () => {
    rendered = renderThemeProbe();

    expect(rendered.container.querySelector("output")?.textContent).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("omni.theme")).toBeNull();
  });

  it("ignores an invalid stored mode", () => {
    window.localStorage.setItem("omni.theme", "sepia");
    rendered = renderThemeProbe();

    expect(rendered.container.querySelector("output")?.textContent).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to light when localStorage getItem throws", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });

    rendered = renderThemeProbe();

    expect(rendered.container.querySelector("output")?.textContent).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("synchronously applies the validated stored mode before rendering", () => {
    window.localStorage.setItem("omni.theme", "dark");
    document.documentElement.dataset.theme = "unset";

    expect(bootstrapTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    window.localStorage.setItem("omni.theme", "sepia");
    expect(bootstrapTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("persists explicit changes and toggles between light and dark", () => {
    window.localStorage.setItem("omni.theme", "dark");
    rendered = renderThemeProbe();

    const buttons = rendered.container.querySelectorAll("button");
    click(buttons[0] as HTMLButtonElement);
    expect(rendered.container.querySelector("output")?.textContent).toBe("dark");
    expect(window.localStorage.getItem("omni.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    click(buttons[1] as HTMLButtonElement);
    expect(rendered.container.querySelector("output")?.textContent).toBe("light");
    expect(window.localStorage.getItem("omni.theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("keeps the visual change when localStorage setItem throws", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });
    rendered = renderThemeProbe();

    click(rendered.container.querySelector("button") as HTMLButtonElement);

    expect(rendered.container.querySelector("output")?.textContent).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
