// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import { projectApi, projectId, projectSnapshot, skills } from "./project-view-fixture";
import type { ResourceSnapshot } from "../../src/domain/resource-catalogue";

describe("project skills canvas", () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof projectApi>;
  let ensureGrant: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    api = projectApi();
    ensureGrant = vi.fn(async () => "grant");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => act(() => root.unmount()));
  async function render(language: "fr" | "en" = "fr", snapshot: ResourceSnapshot = projectSnapshot): Promise<void> {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage={language}>
          <ResourceCanvas
            api={api}
            context={{ kind: "entry", entry: { kind: "project", id: projectId } }}
            snapshot={snapshot}
            onEnsureGrant={ensureGrant}
            onRefresh={vi.fn()}
            onNavigate={vi.fn()}
            onNavigateDestination={vi.fn()}
          />
        </I18nProvider>,
      ),
    );
  }
  async function click(text: string, scope: ParentNode = container): Promise<void> {
    const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text,
    );
    expect(button, text).toBeDefined();
    await act(async () => button!.click());
  }
  async function sheet(): Promise<HTMLElement> {
    await click("Gérer les skills");
    return container.querySelector<HTMLElement>("[data-testid=project-sheet]")!;
  }
  it("groups by origin with one skill node for both agent copies", async () => {
    await render();
    expect(container.textContent).toContain("Seulement dans ce projet");
    const group = container.querySelector<HTMLButtonElement>("[data-project-group=mine] .canvas-node");
    expect(group).not.toBeNull();
    await act(async () => group!.click());
    expect(container.querySelectorAll("[data-skill-row-id=review].canvas-node-row")).toHaveLength(1);
    expect(container.textContent).toContain("✓ Claude Code");
    expect(container.textContent).toContain("✓ Codex");
    expect(container.textContent).toContain("Mise à jour dispo");
  });
  it("names the instruction target and its aliases from observed evidence", async () => {
    await render();
    expect(container.textContent).toContain("Instructions · CLAUDE.md");
    expect(container.textContent).toContain("AGENTS.md, GEMINI.md");
    await sheet();
    await click("Instructions");
    expect(api.readArtifact).toHaveBeenCalledWith(expect.objectContaining({ relativePath: "CLAUDE.md" }));
    expect(container.textContent).toContain("Actual content");
  });
  it("shows each observation diagnostic with its location and reason", async () => {
    await render();
    await sheet();
    await click("Infos");
    expect(container.textContent).toContain(".agents/skills/unreadable");
    expect(container.textContent).toContain("Permission denied while reading skill");
    expect(container.textContent).toContain("plugins/pstack");
    expect(container.textContent).toContain("Git unavailable");
    expect(container.textContent).not.toContain("Some locations could not be observed.");
  });
  it("shows the readable folder and branch status with only a short commit in collapsed details", async () => {
    const head = "a".repeat(40);
    api.readProjectSkills.mockResolvedValue({
      ...skills,
      git: [{ id: "git-project", relativeRoot: "project", branch: "main", head, dirty: true }],
    });
    const snapshot = {
      ...projectSnapshot,
      registry: {
        ...projectSnapshot.registry,
        projects: projectSnapshot.registry.projects.map((project) =>
          project.ref.id === projectId ? { ...project, displayRoot: "~/Projects/notes-app" } : project,
        ),
      },
    };
    await render("fr", snapshot);
    await sheet();
    expect(container.textContent).toContain("~/Projects/notes-app");
    await click("Infos");
    expect(container.textContent).toContain("main · modifications locales");
    expect(container.textContent).not.toContain(head);
    const details = container.querySelector<HTMLDetailsElement>("[data-project-git] details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("aaaaaaa");
  });
  it("previews disabling and applies only after confirmation, then undoes the exact operation", async () => {
    await render();
    const panel = await sheet();
    const row = panel.querySelector("[data-skill-row-id=review]")!;
    await act(async () => row.querySelector<HTMLButtonElement>("[role=switch]")!.click());
    expect(api.applySkillOperation).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid=project-confirmation]")?.textContent).toContain("Omni garde le skill");
    await click("Désactiver", container.querySelector("[data-testid=project-confirmation]")!);
    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: { kind: "project-skill", projectId, rowId: "review", action: "disable" },
    });
    expect(api.applySkillOperation).toHaveBeenCalledWith({ intentId: "intent-1", effectFingerprint: "fingerprint-1" });
    await click("Annuler", container.querySelector("[role=status]")!);
    expect(api.previewSkillOperation).toHaveBeenLastCalledWith({
      intent: { kind: "restore", operationId: "operation-1" },
    });
  });
  it("installs an absent agent with the exact single-agent intent", async () => {
    await render();
    const panel = await sheet();
    await click("+ Codex", panel.querySelector("[data-skill-row-id=local-tool]")!);
    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: { kind: "project-skill", projectId, rowId: "local-tool", action: "install-agent", harnessIds: ["codex"] },
    });
    expect(api.applySkillOperation).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["review", "Il reste dans votre marketplace"],
    ["grill-me", "Il reste disponible dans mattpocock/skills"],
    ["local-tool", "Omni garde une sauvegarde 30 jours"],
  ])("explains what deleting %s keeps", async (id, copy) => {
    await render();
    const panel = await sheet();
    const row = panel.querySelector(`[data-skill-row-id=${id}]`)!;
    await act(async () => row.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")!.click());
    await click("Supprimer…");
    expect(container.querySelector("[data-testid=project-confirmation]")?.textContent).toContain(copy);
    expect(api.applySkillOperation).not.toHaveBeenCalled();
  });
  it("exposes glossary explanations on keyboard focus and keeps programmatic focus quiet", async () => {
    await render();
    await click("? Aide");
    expect(container.querySelector(".resource-canvas")?.classList.contains("is-help-mode")).toBe(true);
    const help = container.querySelector<HTMLElement>("[data-glossary=cost]")!;
    await act(async () => help.focus());
    expect(container.querySelector("[role=tooltip]")).toBeNull();
    await act(async () => {
      help.blur();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      help.focus();
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
    });
    expect(container.querySelector("[role=tooltip]")?.textContent).toContain("Chaque skill actif");
    await act(async () => {
      help.blur();
      help.focus();
    });
    expect(container.querySelector("[role=tooltip]")).toBeNull();
    await act(async () => help.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(container.querySelector("[role=tooltip]")?.textContent).toContain("Chaque skill actif");
  });
  it("shows the same new surfaces in English", async () => {
    await render("en");
    await click("Manage skills");
    expect(container.textContent).toContain("active skills");
    expect(container.textContent).toContain("Only in this project");
    expect(container.textContent).not.toContain("claude-code");
  });
  it("keeps blocked previews visible without writing", async () => {
    api.previewSkillOperation.mockResolvedValue({
      status: "blocked",
      intentId: "blocked",
      reason: "Tree changed",
      details: [],
    } as never);
    await render();
    const panel = await sheet();
    await click("+ Codex", panel.querySelector("[data-skill-row-id=local-tool]")!);
    expect(api.applySkillOperation).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Tree changed");
  });

  it("confirms removing only the clicked installed agent", async () => {
    await render();
    const panel = await sheet();
    await click("✓ Codex", panel.querySelector("[data-skill-row-id=review]")!);
    expect(api.applySkillOperation).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid=project-confirmation]")?.textContent).toContain(
      "Seul Codex ne le verra plus",
    );
    await click("Retirer pour Codex", container.querySelector("[data-testid=project-confirmation]")!);
    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: { kind: "project-skill", projectId, rowId: "review", action: "remove-agent", harnessIds: ["codex"] },
    });
  });

  it("re-enables parked skills only after confirmation", async () => {
    await render();
    const panel = await sheet();
    await click("Désactivés · 1", panel);
    const row = panel.querySelector("[data-skill-row-id=parked]")!;
    await act(async () => row.querySelector<HTMLButtonElement>("[role=switch]")!.click());
    expect(api.applySkillOperation).not.toHaveBeenCalled();
    await click("Réactiver", container.querySelector("[data-testid=project-confirmation]")!);
    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: { kind: "project-skill", projectId, rowId: "parked", action: "enable" },
    });
  });

  it("keeps partial failures and their actual receipt visible", async () => {
    api.applySkillOperation.mockResolvedValue({
      ...(await projectApi().applySkillOperation()),
      status: "partial",
      issues: [
        {
          code: "failed",
          relativePath: ".agents/skills/local-tool",
          message: "Copy changed",
          recoveryAction: "refresh",
        },
      ],
    } as never);
    await render();
    const panel = await sheet();
    await click("+ Codex", panel.querySelector("[data-skill-row-id=local-tool]")!);
    expect(container.querySelector("[role=alert]")?.textContent).toContain(".agents/skills/local-tool · Copy changed");
    expect(container.querySelector("[role=status]")?.textContent).toContain("Certains changements");
    expect(container.querySelector("[role=status] button")?.textContent).toBe("Annuler");
  });

  it("opens the real skill content with read-only external provenance", async () => {
    await render();
    const panel = await sheet();
    await click("grill-me", panel);
    expect(container.querySelector("[data-testid=project-skill-sheet]")?.textContent).toContain("lecture seule");
    expect(api.readArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: ".claude/skills/grill-me/SKILL.md" }),
    );
    expect(container.querySelector("[data-testid=project-skill-sheet]")?.textContent).toContain("Actual content");
  });

  it("does not offer disabled skills to add a second time and applies the chosen assignment", async () => {
    await render();
    await sheet();
    await click("＋ Ajouter des skills");
    const picker = container.querySelector("[data-testid=project-add-skills]")!;
    expect(picker.querySelectorAll(".project-pick-skill")).toHaveLength(1);
    expect(picker.textContent).toContain("Ma marketplace · other");
    const checkbox = picker.querySelector<HTMLInputElement>(".project-pick-skill input")!;
    await act(async () => checkbox.click());
    await click("Ajouter (1)", picker);
    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: {
        kind: "assign",
        sourceId: "source-one",
        packageId: "other",
        artifactPath: "skills/review",
        targets: [{ projectId, harnessIds: ["claude-code", "codex"] }],
      },
    });
    expect(ensureGrant).toHaveBeenCalledWith({ kind: "source", id: "source-one" });
  });

  it("returns focus to the switch when its confirmation is cancelled", async () => {
    await render();
    const panel = await sheet();
    const control = panel.querySelector<HTMLButtonElement>("[data-skill-row-id=review] [role=switch]")!;
    await act(async () => {
      control.focus();
      control.click();
    });
    const confirmation = container.querySelector<HTMLElement>("[data-testid=project-confirmation]")!;
    expect(confirmation.parentElement).toBe(container.querySelector(".resource-canvas"));
    expect(confirmation.closest("[inert]")).toBeNull();
    expect(
      [...confirmation.querySelectorAll<HTMLButtonElement>("button")]
        .filter((button) => !button.hasAttribute("data-glossary"))
        .every((button) => !button.disabled),
    ).toBe(true);
    expect(container.querySelector(".drawer-backdrop")).toBeNull();
    expect(document.activeElement?.textContent).toBe("Annuler");
    await click("Annuler", container.querySelector("[data-testid=project-confirmation]")!);
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(control);
    expect(api.applySkillOperation).not.toHaveBeenCalled();
  });

  it("acquires the marketplace grant before opening the existing S05 workbench", async () => {
    await render();
    const panel = await sheet();
    await act(async () =>
      panel.querySelector<HTMLButtonElement>("[data-skill-row-id=review] [aria-haspopup=menu]")!.click(),
    );
    await click("Mettre à jour");
    expect(ensureGrant).toHaveBeenCalledWith({ kind: "source", id: "source-one" });
    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: {
        kind: "maintain-current",
        source: { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" },
        locations: [
          { projectId, harnessId: "claude-code", folderPath: ".claude/skills/review" },
          { projectId, harnessId: "codex", folderPath: ".agents/skills/review" },
        ],
      },
    });
    expect(api.applySkillOperation).not.toHaveBeenCalled();
  });

  it("shows one skill per logical folder in workspace metadata", async () => {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="fr">
          <ResourceCanvas
            api={{ ...api, readProjectSkills: undefined }}
            context={{ kind: "workspace" }}
            snapshot={projectSnapshot}
            onEnsureGrant={ensureGrant}
            onRefresh={vi.fn()}
            onNavigate={vi.fn()}
            onNavigateDestination={vi.fn()}
          />
        </I18nProvider>,
      ),
    );
    const project = [...container.querySelectorAll(".canvas-node-row")].find((node) =>
      node.textContent?.includes("Project One"),
    )!;
    expect(project.querySelector(".canvas-node-meta")?.textContent).toBe("1 skill");
  });

  it("closes a deleted skill's sheet after re-observation without losing its undo receipt", async () => {
    await render();
    await sheet();
    await click("local-tool");
    api.readProjectSkills.mockResolvedValue({
      ...skills,
      skills: skills.skills.filter((row) => row.id !== "local-tool"),
    });
    await click("Supprimer…", container.querySelector("[data-testid=project-skill-sheet]")!);
    await click("Supprimer", container.querySelector("[data-testid=project-confirmation]")!);
    expect(container.querySelector("[data-testid=project-skill-sheet]")).toBeNull();
    expect(container.querySelector("[role=status] button")?.textContent).toBe("Annuler");
  });

  it("opens capture without a linked identity and leaves correlation to the main preview", async () => {
    api.readProjectSkills.mockResolvedValue({
      ...skills,
      skills: skills.skills.map((row) => (row.id === "local-tool" ? { ...row, skillId: undefined } : row)),
    });
    api.observeSkillCopies.mockResolvedValue({
      status: "ready",
      groups: [
        {
          groupId: "individual",
          correlation: {
            groups: [
              {
                skillId: "22222222-2222-4222-8222-222222222222",
                locations: [
                  { location: { projectId, harnessId: "claude-code", folderPath: ".claude/skills/local-tool" } },
                ],
              },
            ],
          },
        },
      ],
    });
    await render();
    const panel = await sheet();
    await act(async () =>
      panel.querySelector<HTMLButtonElement>("[data-skill-row-id=local-tool] [aria-haspopup=menu]")!.click(),
    );
    await click("Ajouter à ma marketplace");
    expect(container.querySelector("[data-testid=project-capture] .skill-plugin-picker")).not.toBeNull();
    expect(api.observeSkillCopies).not.toHaveBeenCalled();
    expect(api.applySkillOperation).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "labels Cursor and shows it as installed only with observed skills (%s)",
    async (installed) => {
      const snapshot: ResourceSnapshot = {
        ...projectSnapshot,
        roots: projectSnapshot.roots.map((root) =>
          root.entry.id !== projectId || root.evidence.status !== "observed"
            ? root
            : {
                ...root,
                evidence: {
                  ...root.evidence,
                  observation: {
                    ...root.evidence.observation,
                    inventory: {
                      ...root.evidence.observation.inventory,
                      harnesses: ["claude-code", "codex", "cursor", "opencode"],
                      artifacts: [
                        ...root.evidence.observation.inventory.artifacts,
                        {
                          ...root.evidence.observation.inventory.artifacts[0]!,
                          id: "cursor-evidence",
                          kind: installed ? "skill" : "rule",
                          providerIds: ["cursor"],
                          projectionPaths: [installed ? ".cursor/skills/review/SKILL.md" : ".cursor/rules/project.mdc"],
                        },
                      ],
                    },
                  },
                },
              },
        ),
      };
      await render("fr", snapshot);
      const center = container.querySelector(".project-node.is-center")!;
      expect(center.textContent?.includes("✓ Cursor")).toBe(installed);
      expect(center.textContent).not.toContain("opencode");
      await sheet();
      await click("Infos");
      expect(container.querySelector(".project-info")?.textContent?.includes("Cursor")).toBe(installed);
      expect(container.querySelector(".project-info")?.textContent).not.toContain("cursor");
    },
  );

  it("omits missing projects and freshly reads available unobserved projects", async () => {
    const snapshot: ResourceSnapshot = {
      ...projectSnapshot,
      registry: {
        ...projectSnapshot.registry,
        projects: [
          ...projectSnapshot.registry.projects,
          {
            ref: { kind: "project", id: "missing" },
            displayName: "guard-scratch",
            displayRoot: "guard-scratch",
            availability: "missing",
          },
        ],
      },
    };
    await render("fr", snapshot);
    await sheet();
    await click("review");
    expect(container.querySelector("[data-testid=project-skill-sheet]")?.textContent).not.toContain("guard-scratch");
    expect(container.querySelector("[data-testid=project-skill-sheet]")?.textContent).toContain("Project Two");
    expect(api.readProjectSkills).toHaveBeenCalledTimes(2);
  });
  it("omits an installed-in project when its fresh observation fails", async () => {
    const observed = projectSnapshot.roots.find((root) => root.entry.id === projectId)!.evidence;
    const snapshot: ResourceSnapshot = {
      ...projectSnapshot,
      roots: projectSnapshot.roots.map((root) =>
        root.entry.id === "project-two" ? { ...root, evidence: observed } : root,
      ),
    };
    api.readProjectSkills.mockImplementation(async (id) => {
      if (id === "project-two") throw new Error("Observation failed");
      return skills;
    });
    await render("fr", snapshot);
    await sheet();
    await click("review");
    expect(container.querySelector("[data-testid=project-skill-sheet]")?.textContent).toContain(
      "Project Two · Non observé",
    );
    expect([...container.querySelectorAll(".skill-row")].some((row) => row.textContent?.includes("Project Two"))).toBe(
      false,
    );
  });

  it("stretches all group nodes in each grid row to its tallest node", async () => {
    api.readProjectSkills.mockResolvedValue({
      ...skills,
      skills: [
        ...skills.skills,
        ...Array.from({ length: 5 }, (_, i) => ({
          ...skills.skills[0]!,
          id: `extra-${i}`,
          name: `Long skill title ${i}`,
        })),
      ],
    });
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-project-group=mine] .canvas-node")!.click(),
    );
    const rows = [...container.querySelectorAll<HTMLElement>(".project-graph-row")];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.querySelectorAll(".project-node").length)).toEqual([4, 3]);
    expect(rows.every((row) => row.style.alignItems === "stretch")).toBe(true);
  });
});
