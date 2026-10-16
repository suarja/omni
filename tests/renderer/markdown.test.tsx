// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { I18nProvider } from "../../src/renderer/i18n";
import { Markdown } from "../../src/renderer/components/Markdown";

describe("Markdown", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  it("renders supported markdown constructs as React nodes", () => {
    act(() =>
      root?.render(
        <I18nProvider>
          <Markdown
            source={
              "# Hidden\n## Heading\n### Subheading\n\nParagraph with **bold**, *italic*, `code`, and [link](https://example.com).\n\n- one\n- two\n\n1. first\n2. second\n\n> quote\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n```ts\nconst answer = 42;\n```\n\n![alt text](image.png)"
            }
          />
        </I18nProvider>,
      ),
    );

    expect(container?.querySelector("h1")).toBeNull();
    expect(container?.querySelector("h2")?.textContent).toBe("Heading");
    expect(container?.querySelector("h3")?.textContent).toBe("Subheading");
    expect(container?.querySelector("strong")?.textContent).toBe("bold");
    expect(container?.querySelector("em")?.textContent).toBe("italic");
    expect(container?.querySelector("code")?.textContent).toBe("code");
    expect(container?.querySelector("a")?.getAttribute("title")).toBe("https://example.com");
    expect(container?.querySelector("a")?.getAttribute("href")).toBeNull();
    expect(container?.querySelectorAll("ul li")).toHaveLength(2);
    expect(container?.querySelectorAll("ol li")).toHaveLength(2);
    expect(container?.querySelector("blockquote")?.textContent).toBe("quote");
    expect(container?.querySelectorAll("table th")).toHaveLength(2);
    expect(container?.querySelectorAll("table tbody td")).toHaveLength(2);
    expect(container?.querySelector("pre code")?.textContent).toBe("const answer = 42;");
    expect(container?.querySelector("img")).toBeNull();
    expect(container?.textContent).toContain("alt text");
  });

  it("shows raw HTML as text without creating elements", () => {
    act(() =>
      root?.render(
        <I18nProvider>
          <Markdown source="<script>alert(1)</script>" />
        </I18nProvider>,
      ),
    );

    expect(container?.querySelector("script")).toBeNull();
    expect(container?.textContent).toContain("<script>alert(1)</script>");
  });
});
