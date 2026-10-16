import type { Route } from "../../src/renderer/navigation";
import type { AgentRequest } from "../../src/shared/agents-ipc";
import type { OperationReceipt } from "../../src/shared/operations-ipc";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import { projectApi, projectSnapshot } from "./project-view-fixture";
import type { ResourceSnapshot } from "../../src/domain/resource-catalogue";
const counts = {
  unchanged: 0,
  "workshop-changed": 1,
  "storefront-only": 0,
  conflict: 0,
  "added-in-workshop": 0,
  "removed-in-workshop": 0,
};
const storefront = {
  ref: { kind: "source" as const, id: "storefront-one" },
  displayName: "public-tools",
  displayRoot: "~/public-tools",
  availability: "available" as const,
  ownership: "personal" as const,
  role: "storefront" as const,
  capabilities: { observe: true as const, write: false as const },
};
const snapshot: ResourceSnapshot = {
  ...projectSnapshot,
  registry: { ...projectSnapshot.registry, sources: [...projectSnapshot.registry.sources, storefront] },
  roots: [...projectSnapshot.roots, { entry: storefront.ref, evidence: { status: "unobserved" } }],
};
export const plan = {
  planId: "publish-plan",
  kind: "publish-plugin" as const,
  displayTarget: "pstack",
  actions: [
    {
      kind: "write-file" as const,
      relativePath: "plugins/pstack/skills/review/SKILL.md",
      diff: "@@ -1 +1 @@\n-old\n+new",
    },
  ],
  git: { mode: "commit" as const, warnings: [] },
  publication: {
    files: [{ path: "skills/review/SKILL.md", classification: "workshop-changed" as const, added: 1, removed: 1 }],
    conflicts: [] as string[],
    findings: [] as {
      severity: "error";
      code: string;
      message: string;
      fix: string;
      file: string;
      line: number;
      excerpt: string;
    }[],
  },
};
type RenderOptions = { initialPublicationRequest?: AgentRequest; behind?: boolean; legacyStorefrontUse?: boolean } & {
  language?: "fr" | "en";
  receipts?: readonly OperationReceipt[];
  originUrl?: string;
  githubRepository?: string | null;
};
function createApi(options: RenderOptions) {
  return {
    ...projectApi(),
    previewOperation: vi.fn(async () => ({ status: "ready" as const, plan })),
    applyOperation: vi.fn(),
    beginAgentApply: vi.fn(async () => ({ approvedAt: "2026-10-12T10:00:00.000Z", leaseId: "lease-1" })),
    endAgentApply: vi.fn(async () => {}),
    resolveAgentRequest: vi.fn(async () => options.initialPublicationRequest!),
    readPublicationContentChecks: vi.fn(async () => ({ files: [], conflicts: [], findings: [] })),
    openStorefrontRepository: vi.fn(async () => ({ status: "opened" as const })),
    readStorefrontCapabilities: vi.fn(async () => ({ gh: "ready" as const, login: "fixture" })),
    readStorefrontDetails: vi.fn(async () => ({
      status: "ready" as const,
      inspection: {
        status: "ready" as const,
        displayName: "public-tools",
        isGitRepository: true,
        ...(options.githubRepository !== null
          ? { githubRepository: options.githubRepository ?? "fixture/public-tools" }
          : {}),
        ...(options.originUrl ? { originUrl: options.originUrl } : {}),
        licenseFile: "LICENSE",
        plugins: [],
      },
      publications: [],
      license: "MIT",
      description: "Agent skills for content creation.",
    })),
    readStorefrontDrift: vi.fn(async () => ({
      status: "ready" as const,
      storefronts: [
        {
          sourceId: storefront.ref.id,
          name: storefront.displayName,
          plugins: [
            {
              status: "ready" as const,
              pluginId: "pstack",
              files: [{ path: "skills/review/SKILL.md", classification: "workshop-changed" as const }],
              counts,
              behind: options.behind ?? true,
              toPublish: options.behind === false ? 0 : 1,
              conflicts: 0,
            },
          ],
          counts,
          behind: options.behind ?? true,
          behindPlugins: options.behind === false ? 0 : 1,
          unavailablePlugins: 0,
          toPublish: 1,
          conflicts: 0,
        },
      ],
    })),
    listOperations: vi.fn(async () => ({
      status: "ready" as const,
      receipts: options.receipts ?? ([] as readonly OperationReceipt[]),
    })),
  };
}
export async function render(root: Root, options: RenderOptions = {}): Promise<ReturnType<typeof createApi>> {
  const api = createApi(options);
  const grant = vi.fn(async () => "grant");
  function Navigation() {
    const [route, navigate] = useState<Extract<Route, { screen: "resource-canvas" }>>({
      screen: "resource-canvas",
      context: { kind: "workspace" },
    });
    return (
      <I18nProvider initialLanguage={options.language ?? "fr"}>
        <ResourceCanvas
          api={api}
          snapshot={
            options.legacyStorefrontUse && snapshot.uses.status === "ready"
              ? {
                  ...snapshot,
                  uses: {
                    status: "ready",
                    bindings: [
                      ...snapshot.uses.bindings,
                      { ...snapshot.uses.bindings[0]!, bindingId: "legacy-storefront", sourceId: "storefront-one" },
                    ],
                  },
                }
              : snapshot
          }
          initialPublicationRequest={options.initialPublicationRequest}
          {...route}
          onEnsureGrant={grant}
          onRefresh={vi.fn()}
          onNavigate={(next) => {
            if (next.screen === "resource-canvas") navigate(next);
          }}
          onNavigateDestination={vi.fn()}
        />
      </I18nProvider>
    );
  }
  await act(async () => root.render(<Navigation />));
  return api;
}
