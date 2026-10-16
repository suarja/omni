import type { DesktopApi } from "../../src/shared/ipc";
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import type { RegistryView } from "../../src/domain/project-source-registry";
import { Badge } from "../../src/renderer/components/ui/Badge";
import { Card, CardHeader } from "../../src/renderer/components/ui/Card";
import { EmptyState } from "../../src/renderer/components/ui/EmptyState";
import { FooterBar } from "../../src/renderer/components/ui/FooterBar";
import { ItemList, ListItem } from "../../src/renderer/components/ui/ItemList";
import { PageHead } from "../../src/renderer/components/ui/PageHead";
import { I18nProvider } from "../../src/renderer/i18n";
import { AppShell } from "../../src/renderer/shell/AppShell";
import type { AuditSession } from "../../src/renderer/audit/use-audit-session";

const surfacesStyles = readFileSync("src/renderer/components/ui/surfaces.css", "utf8");
const uiStyles = readFileSync("src/renderer/components/ui/ui.css", "utf8");

const source = {
  ref: { kind: "source" as const, id: "personal-source" },
  displayName: "My Marketplace",
  displayRoot: "my-marketplace",
  availability: "available" as const,
  ownership: "personal" as const,
  capabilities: { observe: true as const, write: false as const },
};

const registry: RegistryView = {
  revision: 1,
  projects: [
    {
      ref: { kind: "project" as const, id: "project-one" },
      displayName: "Omni Project",
      displayRoot: "omni-project",
      availability: "available",
    },
  ],
  sources: [source],
};

const audit: AuditSession = {
  status: "completed",
  progress: { completed: 1, total: 1 },
  report: { observations: [], findings: [], unavailable: [] },
  error: null,
  start: vi.fn(),
  cancel: vi.fn(),
  refresh: vi.fn(),
};

type Rendered = Readonly<{ container: HTMLDivElement; root: Root }>;

function render(element: React.ReactElement): Rendered {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => {
    root.render(<I18nProvider initialLanguage="en">{element}</I18nProvider>);
  });
  return { container, root };
}

function shellProps(
  overrides: Partial<React.ComponentProps<typeof AppShell>> = {},
): React.ComponentProps<typeof AppShell> {
  return {
    api: null,
    route: { screen: "home" },
    mode: "light",
    onModeChange: vi.fn(),
    onNavigate: vi.fn(),
    onNavigateToRoute: vi.fn(),
    onReaudit: vi.fn(),
    onRefreshRegistry: vi.fn().mockResolvedValue(null),
    onRetry: vi.fn(),
    openedEntry: null,
    registry: { status: "ready", registry },
    registryBusy: false,
    registryMutationBusy: false,
    registryError: null,
    destinationObservation: null,
    destinationAudit: audit,
    ...overrides,
  };
}

describe("Candidate C surface primitives", () => {
  let rendered: Rendered | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    vi.restoreAllMocks();
  });

  it("counts pending Omni requests on the canvas rail", async () => {
    const pending = {
      requestId: "one",
      approval: "omni",
      status: "pending",
      createdAt: "2026-10-11T00:00:00Z",
      request: { kind: "assign", artifactPath: "skills/review" },
      plan: { kind: "assign", plans: [] },
    };
    const api = {
      listAgentRequests: vi.fn(async () => ({
        requests: [
          pending,
          { ...pending, requestId: "two" },
          { ...pending, requestId: "approved", status: "approved" },
          { ...pending, requestId: "conversation", approval: "conversation" },
        ],
      })),
    } as unknown as DesktopApi;
    rendered = render(<AppShell {...shellProps({ api })} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='canvas-review-count']")?.textContent).toBe("2");
  });

  it("opens the request selected by a system notification", async () => {
    let open: ((requestId: string) => void) | undefined;
    const navigate = vi.fn();
    const pending = {
      requestId: "one",
      approval: "omni",
      status: "pending",
      intentId: "intent-one",
      skillIntent: { kind: "remove", bindingIds: ["binding-one"] },
      request: { kind: "remove-skill", bindingIds: ["binding-one"] },
      plan: { kind: "assign", plans: [] },
    };
    const api = {
      listAgentRequests: vi.fn(async () => ({ requests: [pending] })),
      onOpenAgentRequest: (listener: (id: string) => void) => {
        open = listener;
        return () => {
          open = undefined;
        };
      },
    } as unknown as DesktopApi;
    rendered = render(<AppShell {...shellProps({ api, onNavigateToRoute: navigate })} />);
    await act(async () => {
      open?.("one");
    });
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "one", initialSkillIntentId: "intent-one" }),
    );
  });

  it("renders cards, rows, badges, page heads, empty states, and footer bars with semantic slots", () => {
    const onClick = vi.fn();
    rendered = render(
      <>
        <Card>
          <CardHeader count={<Badge variant="count">2</Badge>} title="Evidence" />
          <ItemList>
            <ListItem
              ariaLabel="Open review skill"
              leading={<Badge variant="type">Skill</Badge>}
              name="Review skill"
              onClick={onClick}
              side={<span>Codex</span>}
              sub={
                <>
                  <span className="ui-item__mono">skills/review/SKILL.md</span>
                  <span>Observed locally</span>
                </>
              }
            />
          </ItemList>
        </Card>
        <PageHead description="Local evidence" title="Library" />
        <EmptyState description="Nothing is here yet." title="No evidence" />
        <FooterBar actions={<button type="button">Continue</button>} note="Read-only" />
      </>,
    );

    expect(rendered.container.querySelector(".ui-card")).not.toBeNull();
    expect(rendered.container.querySelector(".ui-card__header")?.textContent).toContain("Evidence");
    expect(rendered.container.querySelector(".ui-card .ui-item")?.tagName).toBe("BUTTON");
    expect(rendered.container.querySelector(".ui-badge--type")?.textContent).toBe("Skill");
    expect(rendered.container.querySelector(".ui-page-head h1")?.textContent).toBe("Library");
    expect(rendered.container.querySelector(".ui-empty-state")?.textContent).toContain("No evidence");
    expect(rendered.container.querySelector(".ui-footer-bar")?.textContent).toContain("Read-only");

    act(() => rendered?.container.querySelector<HTMLButtonElement>(".ui-card .ui-item")?.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("gives a nested row its accessible name as a whole clickable surface", () => {
    const onClick = vi.fn();
    rendered = render(
      <Card>
        <ItemList>
          <ListItem ariaLabel="Open review" name="Review" onClick={onClick} />
        </ItemList>
      </Card>,
    );

    const row = rendered.container.querySelector<HTMLButtonElement>(".ui-card .ui-item");
    expect(row?.tagName).toBe("BUTTON");
    expect(row?.getAttribute("aria-label")).toBe("Open review");
    expect(row?.tabIndex).toBe(0);
  });

  it("keeps the surface geometry aligned with Candidate C", () => {
    expect(surfacesStyles).toContain(
      "background: linear-gradient(180deg, var(--color-panel-top), var(--color-panel-bottom));",
    );
    expect(surfacesStyles).toContain("box-shadow: inset 0 1px 0 var(--color-panel-highlight);");
    expect(surfacesStyles).not.toMatch(/\.ui-card__header\s*\{[^}]*var\(--color-nested\)/s);
    expect(surfacesStyles).not.toMatch(/\.ui-card__foot\s*\{[^}]*var\(--color-nested\)/s);
    // Dividers are reserved for the card header and the tab strip (product owner, 2026-09-13).
    expect(surfacesStyles).not.toContain("border-top: 1px solid");
    expect(surfacesStyles).toContain("border-radius: var(--radius-card);");
    expect(surfacesStyles).toContain("padding: 12px 20px;");
    expect(surfacesStyles).toContain("padding: 14px 20px;");
    expect(surfacesStyles).toContain("height: 22px;");
    expect(surfacesStyles).toContain("border-radius: var(--radius-pill);");
    expect(surfacesStyles).not.toContain("dashed");
    // CardRow is gone: a nested row is a ListItem inside a nested ItemList (D1), not a separate
    // card-row primitive with its own border-bottom.
    expect(surfacesStyles).not.toContain(".ui-card__row");
  });

  it("uses only the two shared control heights", () => {
    expect(uiStyles).toContain("--control-height");
    expect(uiStyles).toMatch(/\.ui-button\s*\{[^}]*min-height:\s*var\(--control-height\)/s);
    expect(uiStyles).toMatch(/\.ui-button--small\s*\{[^}]*min-height:\s*var\(--control-height-sm\)/s);
    expect(uiStyles).toMatch(/\.ui-icon-button\s*\{[^}]*height:\s*var\(--control-height\)/s);
    const controlRules = (css: string): readonly string[] =>
      (css.match(/[^{}]+\{[^{}]*\}/g) ?? []).filter((rule) =>
        /\.ui-(?:button|icon-button|segmented-control__item|search-field)/.test(rule),
      );
    expect(controlRules(uiStyles).filter((rule) => /\b(?:min-)?height:\s*\d+px/.test(rule))).toEqual([]);
    expect(controlRules(surfacesStyles).filter((rule) => /\b(?:min-)?height:\s*\d+px/.test(rule))).toEqual([]);
  });

  it("renders registered resources in the canvas shell without a sidebar", () => {
    const onNavigateToRoute = vi.fn();
    rendered = render(<AppShell {...shellProps({ onNavigateToRoute })} />);
    expect(rendered.container.querySelector(".sidebar")).toBeNull();
    expect(rendered.container.querySelector("[data-testid='resource-canvas']")).toBeTruthy();
    const source = rendered.container.querySelector<HTMLButtonElement>(
      "[data-testid='canvas-entry-source-personal-source']",
    );
    expect(source?.textContent).toContain("My Marketplace");
    act(() => source?.click());
    expect(rendered.container.querySelector("[data-testid=my-marketplace-sheet]")).toBeNull();
    expect(onNavigateToRoute).toHaveBeenCalledWith({
      screen: "resource-canvas",
      context: { kind: "workspace" },
      canvasPage: { kind: "marketplace" },
    });
  });
});
