// @vitest-environment jsdom

import { act, createElement, StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { EntryRef, Observation, RegistryView } from "../../src/domain/project-source-registry";
import { runReadOnlyAudit, useAuditSession, type AuditSession } from "../../src/renderer/audit/use-audit-session";
import type { DesktopApi } from "../../src/shared/ipc";
import { I18nProvider } from "../../src/renderer/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import {
  projectA,
  projectZ,
  registry,
  observation,
  apiFor,
  InnerAuditSessionHarness,
  AuditSessionHarness,
  flushEffects,
} from "./audit-session-helpers";

describe("audit session lifecycle", () => {
  it("continues after a mismatched grant and returns successful later observations", async () => {
    const progress: Readonly<{ completed: number; total: number }>[] = [];
    const openEntry = vi
      .fn()
      .mockResolvedValueOnce({ status: "granted", entry: projectZ, grantHandle: "wrong-grant" })
      .mockResolvedValue({ status: "granted", entry: projectZ, grantHandle: "project-z-grant" });
    const observeProject = vi.fn().mockResolvedValue({
      status: "observed" as const,
      observation: observation(projectZ.ref),
    });
    const result = await runReadOnlyAudit({
      api: apiFor({ openEntry, observeProject }),
      registry: { status: "ready", registry },
      onProgress: (next) => progress.push(next),
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.report.observations.map(({ subject }) => subject)).toEqual([projectZ.ref]);
    expect(result.report.findings).toEqual([]);
    expect(result.report.unavailable).toEqual([]);
    expect(observeProject).toHaveBeenCalledTimes(1);
    expect(progress.at(-1)).toEqual({ completed: 2, total: 2 });
  });

  it("continues after a mismatched observation and returns successful later observations", async () => {
    const progress: Readonly<{ completed: number; total: number }>[] = [];
    const openEntry = vi.fn().mockImplementation(async (entry) => ({
      status: "granted" as const,
      entry: entry.id === projectA.ref.id ? projectA : projectZ,
      grantHandle: `${entry.id}-grant`,
    }));
    const observeProject = vi.fn().mockImplementation(async (request) => ({
      status: "observed" as const,
      observation: observation(request.projectId === projectA.ref.id ? projectZ.ref : projectZ.ref),
    }));
    const result = await runReadOnlyAudit({
      api: apiFor({ openEntry, observeProject }),
      registry: { status: "ready", registry },
      onProgress: (next) => progress.push(next),
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.report.observations.map(({ subject }) => subject)).toEqual([projectZ.ref]);
    expect(result.report.findings).toEqual([]);
    expect(result.report.unavailable).toEqual([]);
    expect(progress.at(-1)).toEqual({ completed: 2, total: 2 });
  });

  it("puts the hook in an error state for an unexpected API exception", async () => {
    const api = apiFor({ openEntry: vi.fn().mockRejectedValue(new Error("programming failure")) });
    const registryResponse = { status: "ready" as const, registry: { ...registry, projects: [projectA], sources: [] } };
    const container = document.createElement("div");
    const root: Root = createRoot(container);
    let latestSession: AuditSession | undefined;
    act(() => {
      root.render(
        createElement(AuditSessionHarness, {
          api,
          registryResponse,
          onSession: (session) => {
            latestSession = session;
          },
        }),
      );
    });

    act(() => latestSession?.start());
    await flushEffects();

    expect(latestSession?.status).toBe("error");
    expect(latestSession?.error).toEqual({ code: "unexpected-failure" });
    expect(latestSession?.report).toEqual({ observations: [], findings: [], unavailable: [] });

    act(() => root.unmount());
    container.remove();
  });

  it("retains successful later observations in the hook error state", async () => {
    const api = apiFor({
      openEntry: vi.fn().mockImplementation(async (entry) => {
        if (entry.id === projectA.ref.id) throw new Error("unsafe root failure");
        return { status: "granted" as const, entry: projectZ, grantHandle: "project-z-grant" };
      }),
      observeProject: vi.fn().mockResolvedValue({
        status: "observed" as const,
        observation: observation(projectZ.ref),
      }),
    });
    const registryResponse = { status: "ready" as const, registry };
    const container = document.createElement("div");
    const root: Root = createRoot(container);
    let latestSession: AuditSession | undefined;
    act(() => {
      root.render(
        createElement(AuditSessionHarness, {
          api,
          registryResponse,
          onSession: (session) => {
            latestSession = session;
          },
        }),
      );
    });

    act(() => latestSession?.start());
    await flushEffects();

    expect(latestSession?.status).toBe("error");
    expect(latestSession?.error).toEqual({ code: "unexpected-failure" });
    expect(latestSession?.report?.observations.map(({ subject }) => subject)).toEqual([projectZ.ref]);
    expect(latestSession?.report?.findings).toEqual([]);
    expect(latestSession?.report?.unavailable).toEqual([]);

    act(() => root.unmount());
    container.remove();
  });

  it("cancels an active run when the registry identity or revision changes", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = apiFor({
      openEntry: vi.fn().mockImplementation(async () => {
        await pending;
        return { status: "granted" as const, entry: projectA, grantHandle: "stale-grant" };
      }),
    });
    const firstRegistry = {
      status: "ready" as const,
      registry: { ...registry, revision: 4, projects: [projectA], sources: [] },
    };
    const nextRegistry = {
      status: "ready" as const,
      registry: { ...registry, revision: 5, projects: [projectZ], sources: [] },
    };
    const container = document.createElement("div");
    const root: Root = createRoot(container);
    let latestSession: AuditSession | undefined;
    const onSession = (session: AuditSession): void => {
      latestSession = session;
    };
    act(() => root.render(createElement(AuditSessionHarness, { api, registryResponse: firstRegistry, onSession })));
    act(() => latestSession?.start());
    await flushEffects();

    act(() => root.render(createElement(AuditSessionHarness, { api, registryResponse: nextRegistry, onSession })));
    expect(latestSession?.status).toBe("cancelled");
    expect(latestSession?.report).toBeNull();
    release();
    await flushEffects();

    expect(latestSession?.status).toBe("cancelled");
    expect(latestSession?.report).toBeNull();
    expect(api.openEntry).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    container.remove();
  });

  it("cancels an active run when selected refs change, then audits the new selection", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const openEntry = vi
      .fn()
      .mockImplementationOnce(async () => {
        await pending;
        return { status: "granted" as const, entry: projectA, grantHandle: "stale-grant" };
      })
      .mockResolvedValue({ status: "granted", entry: projectZ, grantHandle: "fresh-grant" });
    const observeProject = vi
      .fn()
      .mockResolvedValue({ status: "observed" as const, observation: observation(projectZ.ref) });
    const api = apiFor({ openEntry, observeProject });
    const registryResponse = {
      status: "ready" as const,
      registry: { ...registry, projects: [projectA, projectZ], sources: [] },
    };
    const container = document.createElement("div");
    const root: Root = createRoot(container);
    let latestSession: AuditSession | undefined;
    const onSession = (session: AuditSession): void => {
      latestSession = session;
    };
    act(() =>
      root.render(
        createElement(AuditSessionHarness, {
          api,
          registryResponse,
          onSession,
        }),
      ),
    );
    act(() => latestSession?.start());
    await flushEffects();

    act(() =>
      root.render(
        createElement(AuditSessionHarness, {
          api,
          registryResponse,
          onSession,
          selectedRefs: [projectZ.ref],
        }),
      ),
    );
    expect(latestSession?.status).toBe("cancelled");
    expect(latestSession?.report).toBeNull();
    release();
    await flushEffects();
    expect(api.openEntry).toHaveBeenCalledTimes(1);

    act(() => latestSession?.start());
    await flushEffects();
    expect(api.openEntry).toHaveBeenLastCalledWith(projectZ.ref);
    expect(latestSession?.status).toBe("completed");

    act(() => root.unmount());
    container.remove();
  });

  it("does not invalidate a run when selected refs are recreated with the same meaning", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const openEntry = vi.fn().mockImplementation(async () => {
      await pending;
      return { status: "granted" as const, entry: projectA, grantHandle: "project-grant" };
    });
    const api = apiFor({ openEntry });
    const registryResponse = { status: "ready" as const, registry: { ...registry, projects: [projectA], sources: [] } };
    const container = document.createElement("div");
    const root: Root = createRoot(container);
    let latestSession: AuditSession | undefined;
    const onSession = (session: AuditSession): void => {
      latestSession = session;
    };
    act(() =>
      root.render(
        createElement(AuditSessionHarness, {
          api,
          registryResponse,
          onSession,
          selectedRefs: [projectA.ref],
        }),
      ),
    );
    act(() => latestSession?.start());
    await flushEffects();

    act(() =>
      root.render(
        createElement(AuditSessionHarness, {
          api,
          registryResponse,
          onSession,
          selectedRefs: [{ ...projectA.ref }],
        }),
      ),
    );
    expect(latestSession?.status).toBe("running");
    release();
    await flushEffects();
    expect(latestSession?.status).toBe("completed");

    act(() => root.unmount());
    container.remove();
  });
});
