import { useCallback, useEffect, useRef, useState } from "react";

import type { EntryRef, RegistryEntryView, SourceEntryView } from "../../../domain/project-source-registry";
import type { ResourceContext } from "../../../domain/resource-catalogue";
import type { RegisterProjectResponse, RegisterSourceResponse } from "../../../shared/registry-ipc";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import { useI18n } from "../../i18n";
import type { WorkspaceSetupInputs, WorkspaceSetupIntent } from "./workspace-setup-types";

export type WorkspaceSetupPending = Readonly<{
  entry: EntryRef;
  label: string;
  outcome: "created" | "existing" | "reactivated";
  phase: "waiting-registry" | "registered" | "observing" | "retry" | "observed";
}>;

export type WorkspaceSetupState = Readonly<{
  intent: WorkspaceSetupIntent | null;
  marketplaceMode: "choose" | "connect" | "create";
  ownership: "personal" | "external" | null;
  pending: WorkspaceSetupPending | null;
  creationReceipt: OperationReceipt | null;
  busy: boolean;
  refreshing: boolean;
  error: string | null;
  conflictEntry: SourceEntryView | null;
  refreshAvailable: boolean;
}>;

export type WorkspaceSetupActions = Readonly<{
  open: (intent: WorkspaceSetupIntent) => void;
  close: () => void;
  setMarketplaceMode: (mode: "connect" | "create") => void;
  setOwnership: (ownership: "personal" | "external") => void;
  connectSource: () => Promise<void>;
  registerProject: (grantHandle?: string) => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  retryRead: () => Promise<void>;
  acceptConflict: (entry: SourceEntryView) => void;
  retainCreationReceipt: (receipt: OperationReceipt) => void;
  createdSource: (receipt: OperationReceipt) => void;
}>;

function contextKey(context: ResourceContext): string {
  if (context.kind === "workspace") return "workspace";
  if (context.kind === "entry") return `${context.entry.kind}:${context.entry.id}`;
  if (context.kind === "package") return `${context.entry.kind}:${context.entry.id}:package:${context.packageId}`;
  return `${context.entry.kind}:${context.entry.id}:artifact:${context.artifactId}`;
}

function sameEntry(left: EntryRef, right: EntryRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function findActiveEntry(inputs: WorkspaceSetupInputs, ref: EntryRef): RegistryEntryView | SourceEntryView | undefined {
  const entries = ref.kind === "project" ? inputs.snapshot.registry.projects : inputs.snapshot.registry.sources;
  return entries.find((entry) => sameEntry(entry.ref, ref) && entry.archivedAt === undefined);
}

function findEvidence(inputs: WorkspaceSetupInputs, ref: EntryRef) {
  const root = inputs.snapshot.roots.find((candidate) => sameEntry(candidate.entry, ref));
  if (root?.evidence.status === "observed" && sameEntry(root.evidence.observation.subject, ref)) return root.evidence;
  if (root?.evidence.status === "observed") return undefined;
  return root?.evidence;
}

function readyPending(
  entry: RegistryEntryView | SourceEntryView,
  outcome: WorkspaceSetupPending["outcome"],
): WorkspaceSetupPending {
  return {
    entry: entry.ref,
    label: entry.displayName || entry.displayRoot,
    outcome,
    phase: "waiting-registry",
  };
}

function registrationError(
  response: RegisterProjectResponse | RegisterSourceResponse | null,
  t: ReturnType<typeof useI18n>["t"],
): string | null {
  if (!response || response.status === "cancelled") return null;
  if (response.status === "inaccessible") return response.diagnostic;
  if (response.status === "revision-conflict") return t("canvasSetup.revisionConflict");
  if (response.status === "corrupt") return t("canvasSetup.registryCorrupt");
  if (response.status === "classification-conflict") return t("canvasSetup.classificationConflict");
  return null;
}

export function useWorkspaceSetup(
  inputs: WorkspaceSetupInputs,
  context: ResourceContext,
): Readonly<{ state: WorkspaceSetupState; actions: WorkspaceSetupActions }> {
  const { t } = useI18n();
  const [state, setState] = useState<WorkspaceSetupState>({
    intent: null,
    marketplaceMode: "choose",
    ownership: null,
    pending: null,
    creationReceipt: null,
    busy: false,
    refreshing: false,
    error: null,
    conflictEntry: null,
    refreshAvailable: false,
  });
  const mounted = useRef(true);
  const generation = useRef(0);
  const readAttempt = useRef(0);
  const commandInFlight = useRef(false);
  const lastObserved = useRef<string | null>(null);
  const latestInputs = useRef(inputs);
  latestInputs.current = inputs;
  const currentContext = contextKey(context);
  const previousContext = useRef(currentContext);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      readAttempt.current += 1;
    };
  }, []);

  useEffect(() => {
    if (previousContext.current === currentContext) return;
    previousContext.current = currentContext;
    generation.current += 1;
    readAttempt.current += 1;
    lastObserved.current = null;
    setState((current) => ({
      ...current,
      intent: null,
      pending: null,
      busy: false,
      refreshing: false,
      error: null,
      refreshAvailable: false,
    }));
  }, [currentContext]);

  useEffect(() => {
    const pending = state.pending;
    if (!pending || pending.phase !== "waiting-registry") return;
    const entry = findActiveEntry(inputs, pending.entry);
    if (entry) {
      setState((current) =>
        current.pending?.phase === "waiting-registry"
          ? { ...current, pending: { ...current.pending, phase: "registered" } }
          : current,
      );
    }
  }, [inputs.snapshot.registry, state.pending]);

  useEffect(() => {
    const pending = state.pending;
    if (!pending) return;
    const identity = `${pending.entry.kind}:${pending.entry.id}`;
    if (pending.phase === "registered") {
      if (!findActiveEntry(inputs, pending.entry) || lastObserved.current === identity) return;
      const currentGeneration = generation.current;
      const currentAttempt = ++readAttempt.current;
      lastObserved.current = identity;
      setState((current) =>
        current.pending?.entry && sameEntry(current.pending.entry, pending.entry)
          ? { ...current, pending: { ...current.pending, phase: "observing" } }
          : current,
      );
      void Promise.resolve()
        .then(() => inputs.commands.observeEntry(pending.entry))
        .then(() => {
          if (!mounted.current || generation.current !== currentGeneration || readAttempt.current !== currentAttempt)
            return;
          setState((current) =>
            current.pending?.entry && sameEntry(current.pending.entry, pending.entry)
              ? current.pending.phase === "observing"
                ? { ...current, pending: { ...current.pending, phase: "retry" } }
                : current
              : current,
          );
        })
        .catch(() => {
          if (!mounted.current || generation.current !== currentGeneration || readAttempt.current !== currentAttempt)
            return;
          setState((current) =>
            current.pending?.entry && sameEntry(current.pending.entry, pending.entry)
              ? current.pending.phase === "observing"
                ? { ...current, pending: { ...current.pending, phase: "retry" } }
                : current
              : current,
          );
        });
      return;
    }
    if (pending.phase === "observing" || pending.phase === "retry") {
      const evidence = findEvidence(inputs, pending.entry);
      if (evidence?.status === "observed") {
        setState((current) =>
          current.pending?.entry && sameEntry(current.pending.entry, pending.entry)
            ? { ...current, pending: { ...current.pending, phase: "observed" } }
            : current,
        );
      } else if (pending.phase === "retry" && evidence?.status === "loading") {
        setState((current) =>
          current.pending?.entry && sameEntry(current.pending.entry, pending.entry)
            ? { ...current, pending: { ...current.pending, phase: "observing" } }
            : current,
        );
      }
    }
  }, [inputs, state.pending]);

  const open = useCallback((intent: WorkspaceSetupIntent): void => {
    generation.current += 1;
    readAttempt.current += 1;
    lastObserved.current = null;
    setState({
      intent,
      marketplaceMode: "choose",
      ownership: null,
      pending: null,
      creationReceipt: null,
      busy: false,
      refreshing: false,
      error: null,
      conflictEntry: null,
      refreshAvailable: false,
    });
  }, []);

  const close = useCallback((): void => {
    generation.current += 1;
    readAttempt.current += 1;
    lastObserved.current = null;
    setState((current) => ({
      ...current,
      intent: null,
      pending: null,
      busy: false,
      refreshing: false,
      error: null,
      conflictEntry: null,
      refreshAvailable: false,
    }));
  }, []);

  const setMarketplaceMode = useCallback((mode: "connect" | "create"): void => {
    setState((current) => ({ ...current, marketplaceMode: mode, error: null }));
  }, []);

  const setOwnership = useCallback((ownership: "personal" | "external"): void => {
    setState((current) => ({ ...current, ownership, marketplaceMode: "connect", error: null }));
  }, []);

  const beginRegistration = useCallback(
    async (kind: "project" | "source", grantHandle?: string): Promise<void> => {
      if (commandInFlight.current || state.intent !== (kind === "project" ? "project" : "marketplace")) return;
      if (kind === "source" && !state.ownership) return;
      commandInFlight.current = true;
      const requestGeneration = generation.current;
      setState((current) => ({ ...current, busy: true, error: null }));
      try {
        const response =
          kind === "project"
            ? await (grantHandle ? inputs.commands.registerProject(grantHandle) : inputs.commands.registerProject())
            : await inputs.commands.registerSource(state.ownership!);
        if (!mounted.current || generation.current !== requestGeneration) return;
        if (response?.status === "ready") {
          setState((current) => ({
            ...current,
            pending: readyPending(response.entry, response.outcome),
            error: null,
          }));
        } else if (response?.status === "classification-conflict") {
          setState((current) => ({
            ...current,
            error: registrationError(response, t),
            conflictEntry: response.entry,
            refreshAvailable: false,
          }));
        } else {
          setState((current) => ({
            ...current,
            error: registrationError(response, t),
            refreshAvailable: response?.status === "revision-conflict",
          }));
        }
      } catch {
        if (mounted.current && generation.current === requestGeneration)
          setState((current) => ({ ...current, error: t("canvasSetup.registrationFailed") }));
      } finally {
        commandInFlight.current = false;
        if (mounted.current && generation.current === requestGeneration)
          setState((current) => ({ ...current, busy: false }));
      }
    },
    [inputs.commands, state.intent, state.ownership, t],
  );

  const registerProject = useCallback(
    (grantHandle?: string): Promise<void> => beginRegistration("project", grantHandle),
    [beginRegistration],
  );
  const connectSource = useCallback((): Promise<void> => beginRegistration("source"), [beginRegistration]);

  const refreshWorkspace = useCallback(async (): Promise<void> => {
    if (commandInFlight.current || !state.intent) return;
    const pending = state.pending;
    commandInFlight.current = true;
    const requestGeneration = generation.current;
    setState((current) => ({ ...current, refreshing: true, error: null }));
    try {
      const response = await inputs.commands.refreshRegistry();
      if (!mounted.current || generation.current !== requestGeneration) return;
      if (!response || response.status !== "ready")
        setState((current) => ({
          ...current,
          error: response?.status === "corrupt" ? t("canvasSetup.registryCorrupt") : t("canvasSetup.refreshFailed"),
          refreshAvailable: !pending,
        }));
      else if (
        pending &&
        !response.registry.projects.some((entry) => sameEntry(entry.ref, pending.entry)) &&
        !response.registry.sources.some((entry) => sameEntry(entry.ref, pending.entry))
      )
        setState((current) => ({ ...current, error: t("canvasSetup.registrationNotPublished") }));
      else setState((current) => ({ ...current, error: null, refreshAvailable: false }));
    } catch {
      if (mounted.current && generation.current === requestGeneration)
        setState((current) => ({ ...current, error: t("canvasSetup.refreshFailed"), refreshAvailable: !pending }));
    } finally {
      commandInFlight.current = false;
      if (mounted.current && generation.current === requestGeneration)
        setState((current) => ({ ...current, refreshing: false }));
    }
  }, [inputs.commands, state.intent, state.pending, t]);

  const retryRead = useCallback(async (): Promise<void> => {
    const pending = state.pending;
    if (!pending || !findActiveEntry(latestInputs.current, pending.entry) || commandInFlight.current) return;
    commandInFlight.current = true;
    const requestGeneration = generation.current;
    const requestAttempt = ++readAttempt.current;
    lastObserved.current = `${pending.entry.kind}:${pending.entry.id}`;
    setState((current) =>
      current.pending?.entry && sameEntry(current.pending.entry, pending.entry)
        ? { ...current, pending: { ...current.pending, phase: "observing" }, error: null }
        : current,
    );
    try {
      await inputs.commands.observeEntry(pending.entry);
      if (!mounted.current || generation.current !== requestGeneration || readAttempt.current !== requestAttempt)
        return;
      setState((current) =>
        current.pending?.entry && sameEntry(current.pending.entry, pending.entry)
          ? current.pending.phase === "observing"
            ? { ...current, pending: { ...current.pending, phase: "retry" } }
            : current
          : current,
      );
    } catch {
      if (mounted.current && generation.current === requestGeneration && readAttempt.current === requestAttempt)
        setState((current) =>
          current.pending?.entry && sameEntry(current.pending.entry, pending.entry)
            ? current.pending.phase === "observing"
              ? { ...current, pending: { ...current.pending, phase: "retry" } }
              : current
            : current,
        );
    } finally {
      commandInFlight.current = false;
    }
  }, [inputs.commands, state.pending]);

  const acceptConflict = useCallback((entry: SourceEntryView): void => {
    setState((current) => ({
      ...current,
      pending: readyPending(entry, "existing"),
      error: null,
      conflictEntry: null,
      refreshAvailable: false,
    }));
  }, []);

  const retainCreationReceipt = useCallback(
    (receipt: OperationReceipt): void => {
      const sourceId = receipt.status === "applied" ? receipt.registered?.sourceId : undefined;
      const error =
        receipt.status === "failed"
          ? (receipt.diagnostic ?? t("canvasSetup.actionFailed"))
          : !sourceId
            ? t("canvasSetup.registrationFailed")
            : null;
      setState((current) => ({ ...current, creationReceipt: receipt, error }));
    },
    [t],
  );

  const createdSource = useCallback(
    (receipt: OperationReceipt): void => {
      const sourceId =
        receipt.status === "applied" && receipt.registered?.sourceId ? receipt.registered.sourceId : undefined;
      const receiptError =
        receipt.status === "failed"
          ? (receipt.diagnostic ?? t("canvasSetup.actionFailed"))
          : !sourceId
            ? t("canvasSetup.registrationFailed")
            : null;
      setState((current) => ({ ...current, creationReceipt: receipt, error: receiptError }));
      if (!sourceId) return;
      const requestGeneration = generation.current;
      setState((current) => ({
        ...current,
        pending: {
          entry: { kind: "source", id: sourceId },
          label: receipt.displayTarget,
          outcome: "created",
          phase: "waiting-registry",
        },
        error: null,
        refreshing: true,
        refreshAvailable: false,
      }));
      void inputs.commands
        .refreshRegistry()
        .then((response) => {
          if (!mounted.current || generation.current !== requestGeneration) return;
          if (!response || response.status !== "ready")
            setState((current) => ({
              ...current,
              error: response?.status === "corrupt" ? t("canvasSetup.registryCorrupt") : t("canvasSetup.refreshFailed"),
            }));
          else if (
            !response.registry.sources.some(
              (entry) => entry.ref.kind === "source" && entry.ref.id === sourceId && entry.archivedAt === undefined,
            )
          )
            setState((current) => ({ ...current, error: t("canvasSetup.registrationNotPublished") }));
        })
        .catch(() => {
          if (mounted.current && generation.current === requestGeneration)
            setState((current) => ({ ...current, error: t("canvasSetup.refreshFailed") }));
        })
        .finally(() => {
          if (mounted.current && generation.current === requestGeneration)
            setState((current) => ({ ...current, refreshing: false }));
        });
    },
    [inputs.commands, t],
  );

  const stateWithDiagnostic =
    inputs.diagnostic && !state.error && state.intent ? { ...state, error: inputs.diagnostic } : state;

  return {
    state: stateWithDiagnostic,
    actions: {
      open,
      close,
      setMarketplaceMode,
      setOwnership,
      connectSource,
      registerProject,
      refreshWorkspace,
      retryRead,
      acceptConflict,
      retainCreationReceipt,
      createdSource,
    },
  };
}
