// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../src/renderer/i18n";
import { CatalogueEntryPage } from "../../src/renderer/library/CatalogueEntryPage";
import { CatalogueTab } from "../../src/renderer/library/CatalogueTab";
import type { RegistryView } from "../../src/domain/project-source-registry";
import type {
  CatalogueEntryResponse,
  CatalogueSearchResponse,
  CataloguePrepareImportResponse,
} from "../../src/shared/catalogue-ipc";
import { rootDestination, type Route } from "../../src/renderer/navigation";

const entryView = {
  source: "skills.sh" as const,
  ownerRepo: "anthropics/skills",
  skill: "frontend-design",
  name: "frontend-design",
  description: "Guidance for distinctive, intentional visual design.",
  hasSkillMd: true,
  tags: ["react", "tailwind"],
  installs: 3_400_000,
  official: true,
};

function render(element: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(<I18nProvider initialLanguage="en">{element}</I18nProvider>));
  return { container, root };
}

async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Catalogue tab and entry page", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows a loading row, then rows with name, owner/repo, installs, official and tags", async () => {
    const searchCatalogue = vi.fn<() => Promise<CatalogueSearchResponse>>(async () => ({
      status: "ready",
      results: [{ entry: entryView, score: 10, matchedTags: [] }],
    }));
    const onNavigateToRoute = vi.fn<(route: Route) => void>();
    rendered = render(<CatalogueTab api={{ searchCatalogue }} onNavigateToRoute={onNavigateToRoute} />);
    expect(rendered.container.querySelector("[data-testid='loading-skeleton']")).not.toBeNull();

    await settle();

    const row = rendered.container.querySelector("[data-testid='catalogue-row-anthropics/skills-frontend-design']");
    expect(row?.textContent).toContain("frontend-design");
    expect(row?.textContent).toContain("anthropics/skills");
    expect(row?.textContent).toContain("3.4M");
    expect(row?.textContent).toContain("Official");
    expect(row?.textContent).toContain("react, tailwind");

    act(() => (row as HTMLButtonElement).click());
    expect(onNavigateToRoute).toHaveBeenCalledWith({
      screen: "catalogue-entry",
      ownerRepo: "anthropics/skills",
      skill: "frontend-design",
      returnTo: { screen: "library", tab: "catalogue" },
    });
  });

  it("shows the empty state when no skill matches", async () => {
    const searchCatalogue = vi.fn<() => Promise<CatalogueSearchResponse>>(async () => ({
      status: "ready",
      results: [],
    }));
    rendered = render(<CatalogueTab api={{ searchCatalogue }} onNavigateToRoute={vi.fn()} />);
    await settle();
    expect(rendered.container.textContent).toContain("No skill matches");
  });

  it("re-runs the search with the toggled tag id when a tag chip is clicked", async () => {
    const searchCatalogue = vi.fn<() => Promise<CatalogueSearchResponse>>(async () => ({
      status: "ready",
      results: [],
    }));
    rendered = render(<CatalogueTab api={{ searchCatalogue }} onNavigateToRoute={vi.fn()} />);
    await settle();
    searchCatalogue.mockClear();

    const reactChip = [...rendered.container.querySelectorAll("[data-testid='catalogue-tag-chips'] button")].find(
      (button) => button.textContent === "React",
    );
    expect(reactChip).toBeDefined();
    act(() => (reactChip as HTMLButtonElement).click());
    await settle();

    expect(searchCatalogue).toHaveBeenCalledWith(expect.objectContaining({ tags: ["react"] }));
  });

  it("renders the entry page with the fetched SKILL.md", async () => {
    const getCatalogueEntry = vi.fn<() => Promise<CatalogueEntryResponse>>(async () => ({
      status: "ready",
      entry: entryView,
      skillMd: { status: "ready", content: "## Frontend design\n\nUse React and Tailwind." },
    }));
    rendered = render(
      <CatalogueEntryPage
        api={{ getCatalogueEntry, prepareCatalogueImport: vi.fn() }}
        onNavigateToRoute={vi.fn()}
        ownerRepo="anthropics/skills"
        returnTo={{ screen: "library", tab: "catalogue" }}
        skill="frontend-design"
      />,
    );
    await settle();
    expect(rendered.container.textContent).toContain("frontend-design");
    expect(rendered.container.textContent).toContain("Guidance for distinctive");
    expect(rendered.container.querySelector(".markdown h2")?.textContent).toContain("Frontend design");
  });

  it("shows the honest offline state with a Retry action when the SKILL.md fetch failed", async () => {
    const getCatalogueEntry = vi.fn<() => Promise<CatalogueEntryResponse>>(async () => ({
      status: "ready",
      entry: entryView,
      skillMd: { status: "offline" },
    }));
    rendered = render(
      <CatalogueEntryPage
        api={{ getCatalogueEntry, prepareCatalogueImport: vi.fn() }}
        onNavigateToRoute={vi.fn()}
        ownerRepo="anthropics/skills"
        returnTo={{ screen: "library", tab: "catalogue" }}
        skill="frontend-design"
      />,
    );
    await settle();
    expect(rendered.container.textContent).toContain("skills.sh is unreachable right now.");
    const retry = rendered.container.querySelector("[data-testid='catalogue-skillmd-retry']");
    expect(retry?.textContent).toContain("Retry");
    act(() => (retry as HTMLButtonElement).click());
    await settle();
    expect(getCatalogueEntry).toHaveBeenCalledTimes(2);
  });

  it("navigates to the import route with the prepared grant when Add to my marketplace succeeds", async () => {
    const getCatalogueEntry = vi.fn<() => Promise<CatalogueEntryResponse>>(async () => ({
      status: "ready",
      entry: entryView,
      skillMd: { status: "ready", content: "# Frontend design" },
    }));
    const prepareCatalogueImport = vi.fn<() => Promise<CataloguePrepareImportResponse>>(async () => ({
      status: "ready",
      sourceId: "catalogue-abc123",
      grantHandle: "grant-handle-1",
      relativePath: "skills/frontend-design/SKILL.md",
    }));
    const onNavigateToRoute = vi.fn<(route: Route) => void>();
    rendered = render(
      <CatalogueEntryPage
        api={{ getCatalogueEntry, prepareCatalogueImport }}
        onNavigateToRoute={onNavigateToRoute}
        ownerRepo="anthropics/skills"
        returnTo={{ screen: "library", tab: "catalogue" }}
        skill="frontend-design"
      />,
    );
    await settle();

    const addButton = rendered.container.querySelector<HTMLButtonElement>(
      "[data-testid='catalogue-add-to-marketplace']",
    );
    await act(async () => {
      addButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(prepareCatalogueImport).toHaveBeenCalledWith({ ownerRepo: "anthropics/skills", skill: "frontend-design" });
    expect(onNavigateToRoute).toHaveBeenCalledWith({
      screen: "operation-import-catalogue",
      ownerRepo: "anthropics/skills",
      skill: "frontend-design",
      sourceId: "catalogue-abc123",
      grantHandle: "grant-handle-1",
      relativePath: "skills/frontend-design/SKILL.md",
      name: "frontend-design",
      description: "Guidance for distinctive, intentional visual design.",
      returnTo: {
        screen: "catalogue-entry",
        ownerRepo: "anthropics/skills",
        skill: "frontend-design",
        returnTo: { screen: "library", tab: "catalogue" },
      },
    });
  });

  it("uses Add to project as the primary action when reached from a project", async () => {
    const getCatalogueEntry = vi.fn<() => Promise<CatalogueEntryResponse>>(async () => ({
      status: "ready",
      entry: entryView,
      skillMd: { status: "ready", content: "# Frontend design" },
    }));
    const onNavigateToRoute = vi.fn<(route: Route) => void>();
    rendered = render(
      <CatalogueEntryPage
        api={{ getCatalogueEntry, prepareCatalogueImport: vi.fn() }}
        onNavigateToRoute={onNavigateToRoute}
        ownerRepo="anthropics/skills"
        projectName="Sample Mobile"
        returnTo={{ screen: "project", projectId: "project-one", tab: "overview" }}
        skill="frontend-design"
      />,
    );
    await settle();
    const primary = rendered.container.querySelector<HTMLButtonElement>("[data-testid='catalogue-add-to-project']");
    expect(primary?.textContent).toContain("Add to Sample Mobile");
    expect(rendered.container.textContent).toContain("Projects");
    expect(rendered.container.textContent).toContain("Sample Mobile");
    expect(rendered.container.querySelector("[data-testid='catalogue-add-to-marketplace']")?.className).toContain(
      "ui-button--ghost",
    );
    expect(
      rootDestination({
        screen: "catalogue-entry",
        ownerRepo: "anthropics/skills",
        skill: "frontend-design",
        returnTo: { screen: "project", projectId: "project-one", tab: "overview" },
      }),
    ).toBe("projects");
    act(() => primary?.click());
    expect(onNavigateToRoute).toHaveBeenCalledWith({
      screen: "add-to-project",
      ownerRepo: "anthropics/skills",
      skill: "frontend-design",
      projectId: "project-one",
      returnTo: { screen: "project", projectId: "project-one", tab: "overview" },
    });
  });

  it("shows an inline error and does not navigate when Add to my marketplace cannot prepare the import", async () => {
    const getCatalogueEntry = vi.fn<() => Promise<CatalogueEntryResponse>>(async () => ({
      status: "ready",
      entry: entryView,
      skillMd: { status: "ready", content: "# Frontend design" },
    }));
    const prepareCatalogueImport = vi.fn<() => Promise<CataloguePrepareImportResponse>>(async () => ({
      status: "offline",
    }));
    const onNavigateToRoute = vi.fn<(route: Route) => void>();
    rendered = render(
      <CatalogueEntryPage
        api={{ getCatalogueEntry, prepareCatalogueImport }}
        onNavigateToRoute={onNavigateToRoute}
        ownerRepo="anthropics/skills"
        returnTo={{ screen: "library", tab: "catalogue" }}
        skill="frontend-design"
      />,
    );
    await settle();

    const addButton = rendered.container.querySelector<HTMLButtonElement>(
      "[data-testid='catalogue-add-to-marketplace']",
    );
    await act(async () => {
      addButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onNavigateToRoute).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("skills.sh is unreachable right now.");
  });
});
