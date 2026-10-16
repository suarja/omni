// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../src/renderer/i18n";
import { LearnView } from "../../src/renderer/learn/LearnView";
import { LessonPage } from "../../src/renderer/learn/LessonPage";
import type { AcademyLanguage, AcademyLesson, AcademyLessonSummary } from "../../src/shared/academy-ipc";
import type { Route } from "../../src/renderer/navigation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summaries: AcademyLessonSummary[] = [
  {
    lang: "en",
    kind: "course",
    slug: "skills-plugins-marketplaces",
    title: "Skills, plugins and marketplaces",
    summary: "Understand the shared language behind agent tooling.",
    products: ["claude-code", "codex"],
    illustration: "marketplace",
    topic: "marketplaces",
  },
  {
    lang: "en",
    kind: "tutorial",
    slug: "connect-your-marketplace",
    title: "Connect your marketplace",
    summary: "Make a local marketplace available to Omni.",
    minutes: 4,
    products: ["claude-code", "codex"],
    illustration: "marketplace",
    topic: "marketplaces",
    cta: { route: "library-add", label: "Open Library" },
    steps: ["1. Open Library", "2. Choose a local marketplace", "3. Confirm the connection"],
  },
  {
    lang: "en",
    kind: "topic",
    slug: "skills",
    title: "Skills",
    summary: "Small instruction sets that make agents repeatable.",
    products: ["claude-code", "codex"],
    illustration: "skill",
    topic: "skills",
  },
];

const lesson: AcademyLesson = {
  ...summaries[1]!,
  body: "## 1. Open Library\n\nStart in `Library`.\n\n[illustration:marketplace]\n\n## 2. Choose a local marketplace\n\nPick a source.\n\n## 3. Confirm the connection\n\nRead the result.",
};

function render(element: ReactElement, language: AcademyLanguage = "en"): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(<I18nProvider initialLanguage={language}>{element}</I18nProvider>));
  return { container, root };
}

describe("Learn destination", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => document.body.replaceChildren());
  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    vi.restoreAllMocks();
  });

  it("shows the three content sections and opens a lesson from a card", () => {
    const onNavigateToRoute = vi.fn<(route: Route) => void>();
    rendered = render(<LearnView lessons={summaries} onNavigateToRoute={onNavigateToRoute} />);
    expect(rendered.container.querySelector("[data-testid='learn-courses']")).not.toBeNull();
    expect(rendered.container.querySelector("[data-testid='learn-tutorials']")).not.toBeNull();
    expect(rendered.container.querySelector("[data-testid='learn-topics']")).not.toBeNull();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='lesson-card-course']")?.click());
    expect(onNavigateToRoute).toHaveBeenCalledWith({
      screen: "academy-lesson",
      lang: "en",
      kind: "course",
      slug: "skills-plugins-marketplaces",
    });
  });

  it("navigates a CTA and renders a tutorial table of contents", () => {
    const onNavigateToRoute = vi.fn<(route: Route) => void>();
    rendered = render(<LessonPage lesson={lesson} onNavigateToRoute={onNavigateToRoute} />);
    expect(rendered.container.querySelector("[data-testid='lesson-toc']")).not.toBeNull();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='lesson-cta']")?.click());
    expect(onNavigateToRoute).toHaveBeenCalledWith({ screen: "library-add" });
    expect(rendered.container.querySelector(".markdown code")?.textContent).toBe("Library");
    // `[illustration:<id>]` lines become pictogram tiles, never literal text.
    expect(
      rendered.container.querySelector(".academy-lesson-body [data-testid='illustration-marketplace']"),
    ).not.toBeNull();
    expect(rendered.container.textContent).not.toContain("[illustration:");
  });

  it("renders French copy from the same lesson contract", () => {
    rendered = render(
      <LearnView lessons={summaries.map((item) => ({ ...item, lang: "fr" as const }))} onNavigateToRoute={vi.fn()} />,
      "fr",
    );
    expect(rendered.container.querySelector("h1")?.textContent).toBe("Apprendre");
  });
});
