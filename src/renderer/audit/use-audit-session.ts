import { useCallback, useEffect, useRef, useState } from "react";

import type { EntryRef, Observation, RegistryView } from "../../domain/project-source-registry";
import {
  composeAuditReport,
  selectAuditEntries,
  type AuditObservation,
  type AuditFinding,
  type AuditReport,
} from "./audit-report";
import { registryObservationFingerprint, selectedRefsKey } from "./audit-snapshot";
import type { DesktopApi } from "../../shared/ipc";
import type { ObservationResponse, OpenEntryResponse, RegistryViewResponse } from "../../shared/registry-ipc";
import type { HashArtifactsResponse } from "../../shared/identity-ipc";
import { useI18n, type AppLanguage } from "../i18n";

export type AuditError =
  | Readonly<{ code: "registry-unavailable" }>
  | Readonly<{ code: "unexpected-failure" }>
  | Readonly<{ code: "corrupt-registry"; detail: string }>;
export type AuditProgress = Readonly<{ completed: number; total: number }>;
export type AuditSessionStatus = "idle" | "running" | "completed" | "cancelled" | "error";
export type AuditSessionState = Readonly<{
  status: AuditSessionStatus;
  progress: AuditProgress;
  report: AuditReport | null;
  error: AuditError | null;
  reportRegistryFingerprint?: string | null;
  reportSelectedRefsKey?: string | null;
}>;
export type AuditSession = AuditSessionState &
  Readonly<{
    start: () => void;
    cancel: () => void;
    refresh: () => void;
  }>;
export type AuditRunResult =
  | Readonly<{ status: "completed"; report: AuditReport }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "corrupt"; diagnostic: string }>
  | Readonly<{ status: "error"; error: AuditError; report: AuditReport }>;
export type AuditRunOptions = Readonly<{
  api: DesktopApi;
  registry: RegistryViewResponse;
  selectedRefs?: readonly EntryRef[];
  onProgress?: (progress: AuditProgress) => void;
  signal?: AbortSignal;
  language?: AppLanguage;
}>;

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function availabilityFinding(entry: EntryRef, diagnostic: string): AuditFinding {
  return {
    entry,
    kind: "availability",
    severity: "warning",
    message: diagnostic,
  };
}

function isMatchingObservation(response: ObservationResponse, entry: EntryRef): boolean {
  return (
    response.status === "observed" &&
    response.observation.subject.kind === entry.kind &&
    response.observation.subject.id === entry.id
  );
}

function isMatchingGrant(
  response: OpenEntryResponse,
  entry: EntryRef,
): response is Extract<OpenEntryResponse, { status: "granted" }> {
  return response.status === "granted" && response.entry.ref.kind === entry.kind && response.entry.ref.id === entry.id;
}

async function observeEntry(api: DesktopApi, entry: EntryRef, grantHandle: string): Promise<ObservationResponse> {
  return entry.kind === "project"
    ? api.observeProject({ projectId: entry.id, grantHandle })
    : api.observeSource({ sourceId: entry.id, grantHandle });
}

export async function hashObservation(
  api: DesktopApi,
  entry: EntryRef,
  grantHandle: string,
  observation: Observation,
): Promise<
  | Readonly<{ status: "hashed"; observation: AuditObservation }>
  | Readonly<{ status: "corrupt"; diagnostic: string }>
  | Readonly<{ status: "error"; observation: AuditObservation }>
> {
  if (!api.hashArtifacts) return { status: "hashed", observation };
  const response: HashArtifactsResponse = await api.hashArtifacts({
    kind: entry.kind,
    id: entry.id,
    grantHandle,
    artifacts: observation.inventory.artifacts.map((artifact) => ({
      artifactId: artifact.id,
      relativePath: artifact.relativePath,
      kind: artifact.kind,
    })),
  });
  if (response.status === "corrupt") return { status: "corrupt", diagnostic: response.diagnostic };
  if (response.status === "denied") {
    return {
      status: "error",
      observation: {
        ...observation,
        skipped: observation.inventory.artifacts.map((artifact) => ({
          artifactId: artifact.id,
          reason: "denied" as const,
        })),
      },
    };
  }
  return {
    status: "hashed",
    observation: { ...observation, identities: response.identities, skipped: response.skipped },
  };
}

function appendUnavailable(
  entry: EntryRef,
  diagnostic: string,
  unavailable: EntryRef[],
  findings: AuditFinding[],
): void {
  unavailable.push(entry);
  findings.push(availabilityFinding(entry, diagnostic));
}

export async function runReadOnlyAudit(options: AuditRunOptions): Promise<AuditRunResult> {
  if (options.registry.status === "corrupt") {
    return { status: "corrupt", diagnostic: options.registry.diagnostic };
  }

  const entries = selectAuditEntries(options.registry.registry, options.selectedRefs);
  options.onProgress?.({ completed: 0, total: entries.length });
  const observations: AuditObservation[] = [];
  const findings: AuditFinding[] = [];
  const unavailable: EntryRef[] = [];
  let hasUnexpectedFailures = false;

  for (const [index, entry] of entries.entries()) {
    if (isCancelled(options.signal)) return { status: "cancelled" };
    try {
      const opened = await options.api.openEntry(entry.ref);
      if (isCancelled(options.signal)) return { status: "cancelled" };
      if (opened.status === "corrupt") {
        return { status: "corrupt", diagnostic: opened.diagnostic };
      }
      if (opened.status !== "granted") {
        appendUnavailable(entry.ref, opened.diagnostic, unavailable, findings);
      } else if (!isMatchingGrant(opened, entry.ref)) {
        hasUnexpectedFailures = true;
      } else {
        const observed = await observeEntry(options.api, entry.ref, opened.grantHandle);
        if (isCancelled(options.signal)) return { status: "cancelled" };
        if (observed.status === "corrupt") {
          return { status: "corrupt", diagnostic: observed.diagnostic };
        }
        if (observed.status === "observed") {
          if (isMatchingObservation(observed, entry.ref)) {
            const hashed = await hashObservation(options.api, entry.ref, opened.grantHandle, observed.observation);
            if (hashed.status === "corrupt") return { status: "corrupt", diagnostic: hashed.diagnostic };
            observations.push(hashed.observation);
            if (hashed.status === "error") hasUnexpectedFailures = true;
          } else hasUnexpectedFailures = true;
        } else {
          appendUnavailable(entry.ref, observed.diagnostic, unavailable, findings);
        }
      }
    } catch {
      if (isCancelled(options.signal)) return { status: "cancelled" };
      hasUnexpectedFailures = true;
    }
    options.onProgress?.({ completed: index + 1, total: entries.length });
  }

  const report = composeAuditReport({
    observations,
    findings,
    unavailable,
    registry: options.registry.registry,
    language: options.language,
  });
  return hasUnexpectedFailures
    ? { status: "error", error: { code: "unexpected-failure" }, report }
    : { status: "completed", report };
}

function initialState(): AuditSessionState {
  return {
    status: "idle",
    progress: { completed: 0, total: 0 },
    report: null,
    error: null,
    reportRegistryFingerprint: null,
    reportSelectedRefsKey: null,
  };
}

export type UseAuditSessionOptions = Readonly<{
  api: DesktopApi | null;
  registry: RegistryViewResponse | null;
  selectedRefs?: readonly EntryRef[];
}>;

export function useAuditSession({ api, registry, selectedRefs }: UseAuditSessionOptions): AuditSession {
  const { language } = useI18n();
  const [state, setState] = useState<AuditSessionState>(initialState);
  const runGeneration = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const lifecycle = useRef({ generation: 0, mounted: false });
  const stateRef = useRef(state);
  stateRef.current = state;
  const registryIdentity = useRef<RegistryViewResponse | null>(null);
  const hasRegistryIdentity = useRef(false);
  const registryIdentityGeneration = useRef(0);
  if (!hasRegistryIdentity.current || registryIdentity.current !== registry) {
    registryIdentity.current = registry;
    hasRegistryIdentity.current = true;
    registryIdentityGeneration.current += 1;
  }
  const apiIdentity = useRef<DesktopApi | null>(null);
  const hasApiIdentity = useRef(false);
  const apiIdentityGeneration = useRef(0);
  if (!hasApiIdentity.current || apiIdentity.current !== api) {
    apiIdentity.current = api;
    hasApiIdentity.current = true;
    apiIdentityGeneration.current += 1;
  }
  const selectedKey =
    selectedRefs === undefined
      ? "all"
      : [...new Set(selectedRefs.map(({ kind, id }) => `${kind}:${id}`))].sort().join(",");
  // A run that starts while `selectedRefs` is still `undefined` (scope not yet initialized by the
  // owner) has nothing to invalidate once the owner supplies its first real selection: there is no
  // run under that undefined selection to protect against. Treat that one transition as a no-op so
  // it neither bumps the input generation nor aborts the run that was just accepted.
  const startedUnderUndefinedSelection = useRef(false);
  const previousSelectedRefsUndefined = useRef<boolean | null>(null);
  const bridgingUndefinedSelection =
    previousSelectedRefsUndefined.current === true &&
    selectedRefs !== undefined &&
    !startedUnderUndefinedSelection.current;
  previousSelectedRefsUndefined.current = selectedRefs === undefined;
  const skipNextInvalidation = useRef(false);
  if (bridgingUndefinedSelection) skipNextInvalidation.current = true;
  const registryStateKey =
    registry === null ? "none" : registry.status === "corrupt" ? "corrupt" : `ready:${registry.registry.revision}`;
  const inputKey = `${apiIdentityGeneration.current}:${registryIdentityGeneration.current}:${registryStateKey}:${selectedKey}`;
  const inputGeneration = useRef(0);
  const previousInputKey = useRef<string | null>(null);
  if (previousInputKey.current !== inputKey) {
    previousInputKey.current = inputKey;
    if (!bridgingUndefinedSelection) inputGeneration.current += 1;
  }
  const inputs = useRef({ api, registry, selectedRefs, language });
  inputs.current = { api, registry, selectedRefs, language };

  useEffect(() => {
    const generation = lifecycle.current.generation + 1;
    lifecycle.current = { generation, mounted: true };
    return () => {
      if (lifecycle.current.generation !== generation) return;
      lifecycle.current = { generation, mounted: false };
      runGeneration.current += 1;
      controller.current?.abort();
      controller.current = null;
    };
  }, []);

  useEffect(() => {
    if (skipNextInvalidation.current) {
      skipNextInvalidation.current = false;
      return;
    }
    runGeneration.current += 1;
    controller.current?.abort();
    controller.current = null;
    const current = stateRef.current;
    const total = registry?.status === "ready" ? selectAuditEntries(registry.registry, selectedRefs).length : 0;
    if (current.status === "running" || current.report !== null || current.error !== null) {
      setState({
        status: current.status === "running" ? "cancelled" : "idle",
        progress: { completed: 0, total },
        report: null,
        error: null,
        reportRegistryFingerprint: null,
        reportSelectedRefsKey: null,
      });
    }
  }, [inputKey]);

  const isCurrent = useCallback(
    (generation: number, lifecycleGeneration: number, inputVersion: number): boolean =>
      lifecycle.current.mounted &&
      lifecycle.current.generation === lifecycleGeneration &&
      runGeneration.current === generation &&
      inputGeneration.current === inputVersion,
    [],
  );

  const cancel = useCallback((): void => {
    runGeneration.current += 1;
    controller.current?.abort();
    controller.current = null;
    if (lifecycle.current.mounted)
      setState((current) => (current.status === "running" ? { ...current, status: "cancelled" } : current));
  }, []);

  const start = useCallback((): void => {
    const {
      api: currentApi,
      registry: currentRegistry,
      selectedRefs: currentSelectedRefs,
      language: currentLanguage,
    } = inputs.current;
    if (currentSelectedRefs === undefined) startedUnderUndefinedSelection.current = true;
    runGeneration.current += 1;
    const generation = runGeneration.current;
    const lifecycleGeneration = lifecycle.current.generation;
    const currentInputGeneration = inputGeneration.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    if (!currentApi || !currentRegistry) {
      setState({
        status: "error",
        progress: { completed: 0, total: 0 },
        report: null,
        error: { code: "registry-unavailable" },
      });
      return;
    }
    const total =
      currentRegistry.status === "ready" ? selectAuditEntries(currentRegistry.registry, currentSelectedRefs).length : 0;
    setState({
      status: "running",
      progress: { completed: 0, total },
      report: null,
      error: null,
      reportRegistryFingerprint: null,
      reportSelectedRefsKey: null,
    });
    void runReadOnlyAudit({
      api: currentApi,
      registry: currentRegistry,
      selectedRefs: currentSelectedRefs,
      language: currentLanguage,
      signal: nextController.signal,
      onProgress: (progress) => {
        if (isCurrent(generation, lifecycleGeneration, currentInputGeneration)) {
          setState((current) => ({ ...current, progress }));
        }
      },
    })
      .then((result) => {
        if (!isCurrent(generation, lifecycleGeneration, currentInputGeneration)) return;
        const reportRegistryFingerprint =
          currentRegistry.status === "ready" ? registryObservationFingerprint(currentRegistry.registry) : null;
        const reportSelectedRefsKey = selectedRefsKey(currentSelectedRefs);
        if (result.status === "completed")
          setState((current) => ({
            ...current,
            status: "completed",
            report: result.report,
            reportRegistryFingerprint,
            reportSelectedRefsKey,
          }));
        else if (result.status === "cancelled") setState((current) => ({ ...current, status: "cancelled" }));
        else if (result.status === "corrupt")
          setState((current) => ({
            ...current,
            status: "error",
            error: { code: "corrupt-registry", detail: result.diagnostic },
          }));
        else
          setState((current) => ({
            ...current,
            status: "error",
            error: result.error,
            report: result.report,
            reportRegistryFingerprint,
            reportSelectedRefsKey,
          }));
      })
      .catch(() => {
        if (isCurrent(generation, lifecycleGeneration, currentInputGeneration)) {
          setState((current) => ({ ...current, status: "error", error: { code: "unexpected-failure" } }));
        }
      });
  }, [isCurrent]);

  return { ...state, start, cancel, refresh: start };
}
