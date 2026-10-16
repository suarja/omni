// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { I18nProvider } from "../../src/renderer/i18n";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import type { DesktopApi } from "../../src/shared/ipc";
import { correlateSkillCopies } from "../../src/domain/skill-reconciliation/correlation";
import type { ObserveSkillCopiesRequest } from "../../src/shared/skill-reconciliation-ipc";
import type { SkillLocationKey, SkillMember } from "../../src/domain/skill-reconciliation/types";
import { canvasCopySnapshot } from "./skill-copy-comparison-fixtures";

const fixture = canvasCopySnapshot();
const project = fixture.registry.projects[0]!;
const evidence = fixture.roots.find((root) => root.entry.id === project.ref.id)!.evidence;
if (evidence.status !== "observed") throw new Error("Fixture must be observed.");
const observation = evidence.observation;
const registry = { revision: 1, projects: [project], sources: [] };

function readCopies(request: ObserveSkillCopiesRequest) {
  return {
    status: "ready" as const,
    storeRevision: 1,
    retainedSkills: [],
    managedUses: [],
    groups: request.groups.map((group) => {
      const members: SkillMember[] = group.members.map((member, index) => ({
        ref: member.ref,
        location: {
          projectId: request.projectId,
          harnessId: member.relativePath.startsWith(".claude/") ? "claude-code" : "codex",
          folderPath: member.relativePath.replace(/\/SKILL\.md$/u, ""),
        },
        read: {
          status: "complete",
          revision: {
            algorithm: "omni-tree-v1",
            hash: (index === 0 ? "a" : "b").repeat(64),
            files: [{ path: "SKILL.md", hash: "c".repeat(64), byteLength: 8 }],
          },
        },
      }));
      const locations: readonly SkillLocationKey[] = members.map((member) => member.location);
      return {
        groupId: group.groupId,
        correlation: correlateSkillCopies({
          projectId: request.projectId,
          members,
          records: [{ skillId: "stable-copy", label: "review", evidence: "observed-equivalence", locations }],
          allocateId: () => "unexpected-new-copy",
        }),
      };
    }),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(container: HTMLElement, selector: string): void {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing control: ${selector}`);
  act(() => button.click());
}

test.each([1, 2])(
  "Workspace refresh retains observed copies and attention across registry revision %i",
  async (revision) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const listRegistry = vi
      .fn()
      .mockResolvedValueOnce({ status: "ready", registry })
      .mockResolvedValue({ status: "ready", registry: { ...registry, revision, projects: [{ ...project }] } });
    const observeProject = vi.fn().mockResolvedValue({ status: "observed", observation });
    const observeSkillCopies = vi.fn().mockImplementation(readCopies);
    const api = {
      listRegistry,
      openEntry: vi.fn().mockResolvedValue({ status: "granted", entry: project, grantHandle: "grant" }),
      observeProject,
      observeSkillCopies,
    } as unknown as DesktopApi;
    const previousApi = window.omni;
    window.omni = api;
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ThemeProvider>
            <I18nProvider initialLanguage="en">
              <App />
            </I18nProvider>
          </ThemeProvider>,
        ),
      );
      if (container.querySelector("[data-testid='onboarding-skip']"))
        click(container, "[data-testid='onboarding-skip']");
      click(container, ".canvas-node[data-kind='project']");
      await flush();
      expect(container.querySelector(".canvas-node[data-kind='project']")?.getAttribute("data-attention")).toBe(
        "copy-difference",
      );
      click(container, ".canvas-breadcrumbs button:first-child");
      await flush();
      expect(container.querySelector(".canvas-node[data-kind='project']")?.getAttribute("data-state")).toBe("observed");
      expect(container.querySelector(".canvas-node[data-kind='project']")?.getAttribute("data-attention")).toBe(
        "copy-difference",
      );
      const copyReads = observeSkillCopies.mock.calls.length;
      click(container, "button[aria-label='Refresh']");
      await flush();
      expect(listRegistry).toHaveBeenCalledTimes(2);
      expect(container.querySelector(".canvas-node[data-kind='project']")?.getAttribute("data-state")).toBe("observed");
      expect(container.querySelector(".canvas-node[data-kind='project']")?.getAttribute("data-attention")).toBe(
        "copy-difference",
      );
      expect(observeProject).toHaveBeenCalledTimes(1);
      expect(observeSkillCopies).toHaveBeenCalledTimes(copyReads);
    } finally {
      act(() => root.unmount());
      container.remove();
      window.omni = previousApi;
    }
  },
);
