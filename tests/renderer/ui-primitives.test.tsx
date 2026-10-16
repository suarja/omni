// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "../../src/renderer/components/ui/Button";
import { Callout } from "../../src/renderer/components/ui/Callout";
import { IconButton } from "../../src/renderer/components/ui/IconButton";
import { SearchField } from "../../src/renderer/components/ui/SearchField";
import { SegmentedControl } from "../../src/renderer/components/ui/SegmentedControl";

type Rendered = Readonly<{ container: HTMLDivElement; root: Root }>;

function render(element: ReactElement): Rendered {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

describe("shared renderer UI primitives", () => {
  let rendered: Rendered | undefined;
  let actEnvironmentDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.replaceChildren();
  });

  afterEach(() => {
    act(() => {
      rendered?.root.unmount();
    });
    rendered?.container.remove();
    rendered = undefined;
    vi.restoreAllMocks();
    if (actEnvironmentDescriptor) {
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironmentDescriptor);
    } else {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
    actEnvironmentDescriptor = undefined;
  });

  it("renders a named button with a semantic tone, size, icon, and forwarded disabled state", () => {
    rendered = render(
      <Button disabled icon="plus" size="small" tone="primary">
        Add project
      </Button>,
    );

    const button = rendered.container.querySelector("button");

    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Add project");
    expect(button?.className).toContain("ui-button--primary");
    expect(button?.className).toContain("ui-button--small");
    expect(button?.querySelector("svg")).not.toBeNull();
  });

  it("does not add a trailing arrow or hide a button's accessible name", () => {
    rendered = render(<Button>Continue</Button>);

    const button = rendered.container.querySelector("button");

    expect(button?.textContent).toBe("Continue");
    expect(button?.getAttribute("aria-label")).toBeNull();
    expect(button?.querySelector("svg")).toBeNull();
  });

  it("forwards an optional accessible name without changing visible text", () => {
    rendered = render(<Button ariaLabel="Continue to the next step">Continue</Button>);

    const button = rendered.container.querySelector("button");

    expect(button?.textContent).toBe("Continue");
    expect(button?.getAttribute("aria-label")).toBe("Continue to the next step");
  });

  it("renders an icon button as a labelled, focusable native button", () => {
    rendered = render(<IconButton icon="settings" label="Open settings" />);

    const button = rendered.container.querySelector("button");

    expect(button?.getAttribute("aria-label")).toBe("Open settings");
    expect(button?.disabled).toBe(false);
    expect(button?.tabIndex).not.toBe(-1);
    expect(button?.querySelector("svg")).not.toBeNull();
  });

  it("rejects an icon button with an empty accessible label", () => {
    expect(() => render(<IconButton icon="settings" label="   " />)).toThrow(
      "IconButton requires a non-empty accessible label.",
    );
  });

  it("renders filter segments as pressed buttons and reports the newly selected value", () => {
    const onValueChange = vi.fn<(value: "all" | "recent") => void>();

    function SegmentedProbe(): ReactElement {
      const [value, setValue] = useState<"all" | "recent">("all");

      return (
        <SegmentedControl
          ariaLabel="Plugin scope"
          onValueChange={(nextValue) => {
            onValueChange(nextValue);
            setValue(nextValue);
          }}
          options={[
            { label: "All", value: "all" },
            { label: "Recent", value: "recent" },
          ]}
          value={value}
        />
      );
    }

    rendered = render(<SegmentedProbe />);

    const group = rendered.container.querySelector('[role="group"]');
    const buttons = Array.from(group?.querySelectorAll("button") ?? []);

    expect(group?.getAttribute("aria-label")).toBe("Plugin scope");
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");

    click(buttons[1] as HTMLButtonElement);

    expect(onValueChange).toHaveBeenCalledWith("recent");
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("wires a labelled search input and reports its value", () => {
    const onChange = vi.fn<(value: string) => void>();
    rendered = render(<SearchField label="Search plugins" onChange={onChange} placeholder="Search" value="" />);

    const input = rendered.container.querySelector("input");
    const label = rendered.container.querySelector("label");

    expect(input?.type).toBe("search");
    expect(input?.placeholder).toBe("Search");
    expect(input?.getAttribute("aria-label")).toBe("Search plugins");
    expect(label?.getAttribute("for")).toBe(input?.id);
    expect(rendered.container.querySelector("svg")).not.toBeNull();

    act(() => {
      if (!input) {
        throw new Error("Search input is missing.");
      }
      const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setInputValue?.call(input, "skills");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("skills");
  });

  it("exposes a titled alert callout with semantic tone and content", () => {
    rendered = render(
      <Callout title="Source unavailable" tone="warning">
        Reconnect the source to continue.
      </Callout>,
    );

    const callout = rendered.container.querySelector('[role="alert"]');
    const title = rendered.container.querySelector("strong");

    expect(callout?.className).toContain("ui-callout--warning");
    expect(callout?.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(title?.textContent).toBe("Source unavailable");
    expect(callout?.textContent).toContain("Reconnect the source to continue.");
  });
});
