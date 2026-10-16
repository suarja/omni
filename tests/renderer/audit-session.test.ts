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
  it("suppresses an older run when refresh starts a replacement report", async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const openEntry = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstPending;
        return { status: "granted" as const, entry: projectA, grantHandle: "first-grant" };
      })
      .mockResolvedValue({ status: "granted", entry: projectA, grantHandle: "second-grant" });
    const api = apiFor({ openEntry });
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
    act(() => latestSession?.refresh());
    await flushEffects();
    expect(latestSession?.status).toBe("completed");
    expect(latestSession?.report?.findings).toEqual([]);

    releaseFirst();
    await flushEffects();
    expect(latestSession?.status).toBe("completed");
    expect(latestSession?.report?.findings).toEqual([]);

    act(() => root.unmount());
    container.remove();
  });

  it("replaces the previous report when a refresh begins", async () => {
    let releaseRefresh!: () => void;
    const refreshPending = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const firstObservation = observation(projectA.ref, [
      {
        location: "first-run",
        code: "unsupported",
        severity: "warning",
        message: "First run diagnostic.",
      },
    ]);
    const openEntry = vi
      .fn()
      .mockResolvedValueOnce({ status: "granted", entry: projectA, grantHandle: "first-grant" })
      .mockImplementationOnce(async () => {
        await refreshPending;
        return { status: "granted", entry: projectA, grantHandle: "refresh-grant" };
      });
    const observeProject = vi
      .fn()
      .mockResolvedValueOnce({ status: "observed" as const, observation: firstObservation })
      .mockResolvedValue({ status: "observed" as const, observation: observation(projectA.ref) });
    const api = apiFor({ openEntry, observeProject });
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
    expect(latestSession?.status).toBe("completed");
    expect(latestSession?.report?.findings).toHaveLength(1);

    act(() => latestSession?.refresh());
    expect(latestSession?.status).toBe("running");
    expect(latestSession?.progress).toEqual({ completed: 0, total: 1 });
    expect(latestSession?.report).toBeNull();

    releaseRefresh();
    await flushEffects();
    expect(latestSession?.status).toBe("completed");
    expect(latestSession?.report?.findings).toEqual([]);

    act(() => root.unmount());
    container.remove();
  });

  it("continues reporting progress and completion after a StrictMode remount", async () => {
    const api = apiFor();
    const registryResponse = { status: "ready" as const, registry: { ...registry, projects: [projectA], sources: [] } };
    const container = document.createElement("div");
    const root: Root = createRoot(container);
    let latestSession: AuditSession | undefined;
    act(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(AuditSessionHarness, {
            api,
            registryResponse,
            onSession: (session) => {
              latestSession = session;
            },
          }),
        ),
      );
    });

    act(() => latestSession?.start());
    await flushEffects();

    expect(latestSession?.status).toBe("completed");
    expect(latestSession?.progress).toEqual({ completed: 1, total: 1 });
    expect(latestSession?.report?.observations).toHaveLength(1);

    act(() => root.unmount());
    container.remove();
  });

  it("returns a safe error when preload or IPC throws instead of an availability warning", async () => {
    const result = await runReadOnlyAudit({
      api: apiFor({
        openEntry: vi
          .fn()
          .mockRejectedValue(new Error("Error invoking remote method: /private/project secret=top-secret")),
      }),
      registry: { status: "ready", registry: { ...registry, projects: [projectA], sources: [] } },
    });

    expect(result).toEqual({
      status: "error",
      error: { code: "unexpected-failure" },
      report: { observations: [], findings: [], unavailable: [] },
    });
  });

  it("returns a safe error when an observation call throws", async () => {
    const result = await runReadOnlyAudit({
      api: apiFor({
        observeProject: vi.fn().mockRejectedValue(new Error("parser leaked /private/project")),
      }),
      registry: { status: "ready", registry: { ...registry, projects: [projectA], sources: [] } },
    });

    expect(result).toEqual({
      status: "error",
      error: { code: "unexpected-failure" },
      report: { observations: [], findings: [], unavailable: [] },
    });
  });

  it("continues after a thrown root and returns successful later observations", async () => {
    const progress: Readonly<{ completed: number; total: number }>[] = [];
    const openEntry = vi.fn().mockImplementation(async (entry) => {
      if (entry.id === projectA.ref.id) throw new Error("unsafe preload detail");
      return { status: "granted" as const, entry: projectZ, grantHandle: "project-z-grant" };
    });
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
    expect(result.error).toEqual({ code: "unexpected-failure" });
    expect(result.report.observations.map(({ subject }) => subject)).toEqual([projectZ.ref]);
    expect(result.report.findings).toEqual([]);
    expect(result.report.unavailable).toEqual([]);
    expect(progress).toEqual([
      { completed: 0, total: 2 },
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
  });
});
