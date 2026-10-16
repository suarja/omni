// @vitest-environment jsdom

import { act, createElement, StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { EntryRef, Observation, RegistryView } from "../../src/domain/project-source-registry";
import { runReadOnlyAudit, useAuditSession, type AuditSession } from "../../src/renderer/audit/use-audit-session";
import type { DesktopApi } from "../../src/shared/ipc";
import { I18nProvider } from "../../src/renderer/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const projectA = {
  ref: { kind: "project" as const, id: "project-a" },
  displayName: "Project A",
  displayRoot: "project-a",
  availability: "available" as const,
};
export const projectZ = {
  ref: { kind: "project" as const, id: "project-z" },
  displayName: "Project Z",
  displayRoot: "project-z",
  availability: "available" as const,
};
export const registry: RegistryView = {
  revision: 4,
  projects: [projectZ, projectA],
  sources: [],
};

export function observation(
  subject: Observation["subject"],
  diagnostics: Observation["inventory"]["diagnostics"] = [],
): Observation {
  return {
    subject,
    observedAt: "2026-09-11T10:00:00.000Z",
    inventory: {
      rootHandle: "opaque-grant",
      displayRoot: subject.id,
      observedAt: "2026-09-11T10:00:00.000Z",
      harnesses: [],
      artifacts: [],
      diagnostics,
      gitScopes: [],
    },
  };
}

export function apiFor(handlers: Partial<DesktopApi> = {}): DesktopApi {
  return {
    listRegistry: vi.fn(),
    registerProject: vi.fn(),
    registerSource: vi.fn(),
    openEntry: vi.fn().mockResolvedValue({ status: "granted", entry: projectA, grantHandle: "project-grant" }),
    observeProject: vi.fn().mockResolvedValue({ status: "observed", observation: observation(projectA.ref) }),
    observeSource: vi.fn(),
    archiveEntry: vi.fn(),
    reactivateEntry: vi.fn(),
    ...handlers,
  };
}

export function InnerAuditSessionHarness({
  api,
  registryResponse,
  onSession,
  selectedRefs,
}: Readonly<{
  api: DesktopApi;
  registryResponse: Parameters<typeof runReadOnlyAudit>[0]["registry"];
  onSession: (session: AuditSession) => void;
  selectedRefs?: readonly EntryRef[];
}>): null {
  onSession(useAuditSession({ api, registry: registryResponse, selectedRefs }));
  return null;
}

export function AuditSessionHarness(
  props: Readonly<{
    api: DesktopApi;
    registryResponse: Parameters<typeof runReadOnlyAudit>[0]["registry"];
    onSession: (session: AuditSession) => void;
    selectedRefs?: readonly EntryRef[];
  }>,
): ReactElement {
  return createElement(I18nProvider, {
    initialLanguage: "en",
    children: createElement(InnerAuditSessionHarness, props),
  });
}

export async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
