import { useEffect, useRef, type KeyboardEvent, type ReactElement, type RefObject } from "react";
import { SheetFrame } from "../SheetFrame";

import type { EntryRef } from "../../../domain/project-source-registry";
import { createResourceCatalogue } from "../../../domain/resource-catalogue";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import { useI18n } from "../../i18n";
import { AddMarketplaceSheet } from "./AddMarketplaceSheet";
import { AddProjectSheet } from "./AddProjectSheet";
import type { WorkspaceSetupActions, WorkspaceSetupPending, WorkspaceSetupState } from "./use-workspace-setup";
import type { WorkspaceSetupInputs } from "./workspace-setup-types";

function sameEntry(left: EntryRef, right: EntryRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function pendingRoot(inputs: WorkspaceSetupInputs, entry: EntryRef) {
  return inputs.snapshot.roots.find((candidate) => sameEntry(candidate.entry, entry));
}

function gitModeLabel(mode: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (mode === "init-and-commit") return t("canvasSetup.gitInit");
  if (mode === "commit") return t("canvasSetup.gitCommit");
  if (mode === "enclosing-repository") return t("canvasSetup.gitEnclosing");
  if (mode === "not-a-repository") return t("canvasSetup.gitNotRepository");
  if (mode === "disabled") return t("canvasSetup.gitDisabled");
  return t("canvasSetup.gitUnavailable");
}

function useSheetFocus(
  intent: WorkspaceSetupState["intent"],
  phase: WorkspaceSetupPending["phase"] | undefined,
  hasReceipt: boolean,
): RefObject<HTMLDivElement | null> {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = sheet.current?.querySelector<HTMLElement>(
      ".canvas-setup-focus, .canvas-setup-body button:not(:disabled), .canvas-setup-body input:not(:disabled)",
    );
    (target ?? sheet.current)?.focus();
  }, [hasReceipt, intent, phase]);
  return sheet;
}

function ReceiptDetails({ receipt }: Readonly<{ receipt: OperationReceipt }>): ReactElement {
  const { t } = useI18n();
  return (
    <details className="canvas-setup-receipt-details">
      <summary>{t("canvasSetup.operationDetails")}</summary>
      <p>
        {t("canvasSetup.gitPlan")}: {gitModeLabel(receipt.git.mode, t)}
      </p>
      <ul>
        {receipt.actions.map((action) => (
          <li key={`${action.kind}:${action.relativePath}`}>
            <code>{action.relativePath}</code> · {action.status}
          </li>
        ))}
      </ul>
      {receipt.diagnostic ? <p role="alert">{receipt.diagnostic}</p> : null}
    </details>
  );
}

function nextAction(
  entry: EntryRef,
  ownership: "personal" | "external" | undefined,
  activePersonalSource: boolean,
  activeProject: boolean,
): "project" | "marketplace" | "agents" | "done" {
  if (entry.kind === "source" && ownership === "external") return "done";
  if (activePersonalSource && activeProject) return "agents";
  if (entry.kind === "source" && !activeProject) return "project";
  if (entry.kind === "project" && !activePersonalSource) return "marketplace";
  return "done";
}

function SetupResult(
  props: Readonly<{
    setup: WorkspaceSetupInputs;
    state: WorkspaceSetupState;
    actions: WorkspaceSetupActions;
    activePersonalSource: boolean;
    activeProject: boolean;
    onClose: () => void;
    onOpenAgents: () => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const pending = props.state.pending;
  if (!pending) return <div />;
  const root = pendingRoot(props.setup, pending.entry);
  const observed = root?.evidence.status === "observed" && sameEntry(root.evidence.observation.subject, pending.entry);
  const listing = observed
    ? createResourceCatalogue(props.setup.snapshot).browse({ kind: "entry", entry: pending.entry })
    : null;
  const count = listing?.children.filter((resource) => resource.state === "observed").length ?? 0;
  const source =
    pending.entry.kind === "source"
      ? props.setup.snapshot.registry.sources.find((entry) => sameEntry(entry.ref, pending.entry))
      : undefined;
  const ownership = source?.ownership ?? props.state.ownership ?? undefined;
  const action = nextAction(pending.entry, ownership, props.activePersonalSource, props.activeProject);
  const progress =
    pending.phase === "waiting-registry"
      ? t("canvasSetup.waitingForRegistry")
      : pending.phase === "registered" || pending.phase === "observing"
        ? t("canvasSetup.reading")
        : null;

  return (
    <section className="canvas-setup-result" data-testid="canvas-setup-registration-result" aria-live="polite">
      <h3 className="canvas-setup-focus" tabIndex={-1}>
        {pending.label}
      </h3>
      <p>{t(`canvasSetup.outcomes.${pending.outcome}`)}</p>
      <p>
        {pending.entry.kind === "project"
          ? t("canvasSetup.projectType")
          : ownership === "external"
            ? t("canvasSetup.externalType")
            : t("canvasSetup.personalType")}
      </p>
      {progress ? (
        <p className="canvas-setup-progress" role="status">
          {progress}
        </p>
      ) : null}
      {observed && listing ? (
        <p className="canvas-setup-inventory" data-testid="canvas-setup-observed-summary">
          {listing.status === "partial"
            ? t("canvasSetup.inventoryPartial", { count })
            : listing.status === "unavailable"
              ? t("canvasSetup.inventoryUnavailable")
              : t("canvasSetup.observedResources", { count })}
        </p>
      ) : pending.phase === "observed" ? (
        <p>{t("canvasSetup.inventoryUnavailable")}</p>
      ) : null}
      {pending.phase === "retry" ? (
        <>
          <p className="canvas-setup-error" role="alert">
            {root?.evidence.status === "unavailable"
              ? t("canvasSetup.readUnavailable")
              : t("canvasSetup.readIncomplete")}
          </p>
          <div className="canvas-setup-actions">
            <button
              data-testid="canvas-setup-retry-read"
              disabled={props.state.busy}
              onClick={() => void props.actions.retryRead()}
              type="button"
            >
              {t("canvasSetup.retryRead")}
            </button>
          </div>
        </>
      ) : null}
      {props.state.error ? (
        <p className="canvas-setup-error" role="alert">
          {props.state.error}
        </p>
      ) : null}
      {pending.phase === "waiting-registry" ? (
        <div className="canvas-setup-actions">
          <button
            data-testid="canvas-setup-refresh-registry"
            disabled={props.state.refreshing || props.state.busy}
            onClick={() => void props.actions.refreshWorkspace()}
            type="button"
          >
            {props.state.refreshing ? t("canvasSetup.refreshing") : t("canvasSetup.refreshWorkspace")}
          </button>
        </div>
      ) : null}
      {pending.phase === "observed" ? (
        <div className="canvas-setup-actions">
          {action === "project" ? (
            <button data-testid="canvas-setup-add-project" onClick={() => props.actions.open("project")} type="button">
              {t("canvasSetup.addProject")}
            </button>
          ) : null}
          {action === "marketplace" ? (
            <button
              data-testid="canvas-setup-add-marketplace"
              onClick={() => props.actions.open("marketplace")}
              type="button"
            >
              {t("canvasSetup.addMarketplace")}
            </button>
          ) : null}
          {action === "agents" ? (
            <button data-testid="canvas-setup-connect-agents" onClick={props.onOpenAgents} type="button">
              {t("canvasSetup.connectAgents")}
            </button>
          ) : null}
          <button className="is-secondary" data-testid="canvas-setup-done" onClick={props.onClose} type="button">
            {t("canvasSetup.done")}
          </button>
        </div>
      ) : null}
      {props.state.creationReceipt ? <ReceiptDetails receipt={props.state.creationReceipt} /> : null}
    </section>
  );
}

export function WorkspaceSetupSheet(
  props: Readonly<{
    setup: WorkspaceSetupInputs;
    state: WorkspaceSetupState;
    actions: WorkspaceSetupActions;
    activePersonalSource: boolean;
    activeProject: boolean;
    applying: boolean;
    initialExternalRepository?: string;
    onApplyingChange: (applying: boolean) => void;
    onClose: () => void;
    onOpenAgents: () => void;
  }>,
): ReactElement | null {
  const { t } = useI18n();
  const intent = props.state.intent;
  const sheetRef = useSheetFocus(intent, props.state.pending?.phase, Boolean(props.state.creationReceipt));
  if (!intent) return null;
  if (!props.state.pending && !props.state.creationReceipt) {
    if (intent === "project")
      return (
        <AddProjectSheet setup={props.setup} state={props.state} actions={props.actions} onClose={props.onClose} />
      );
    return (
      <AddMarketplaceSheet
        initialRepository={props.initialExternalRepository}
        setup={props.setup}
        state={props.state}
        actions={props.actions}
        onClose={props.onClose}
        onApplyingChange={props.onApplyingChange}
      />
    );
  }
  const title = t(`canvasSetup.titles.${intent}`);
  const close = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!props.applying) props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(sheetRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), summary, [tabindex='0']",
      ) ?? []),
    ];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <SheetFrame
      title={title}
      closeLabel={t("canvasSetup.close")}
      kicker={t("canvasSetup.sheetLabel")}
      className="canvas-setup-sheet"
      testId="canvas-setup-sheet"
      sheetRef={sheetRef}
      onKeyDown={close}
      modal
      busy={props.applying}
      onClose={props.onClose}
      resizeKind="setup"
      focusClose={false}
      bodyClassName="canvas-setup-body"
    >
      {props.state.pending ? (
        <SetupResult
          actions={props.actions}
          activePersonalSource={props.activePersonalSource}
          activeProject={props.activeProject}
          onClose={props.onClose}
          onOpenAgents={props.onOpenAgents}
          setup={props.setup}
          state={props.state}
        />
      ) : (
        <section className="canvas-setup-result" data-testid="canvas-setup-marketplace-receipt" aria-live="polite">
          <h3 className="canvas-setup-focus" tabIndex={-1}>
            {t("canvasSetup.actionResult")}
          </h3>
          <p>{props.state.creationReceipt?.displayTarget}</p>
          {props.state.error ? (
            <p className="canvas-setup-error" role="alert">
              {props.state.error}
            </p>
          ) : null}
          {props.state.creationReceipt ? <ReceiptDetails receipt={props.state.creationReceipt} /> : null}
          <div className="canvas-setup-actions">
            <button className="is-secondary" data-testid="canvas-setup-done" onClick={props.onClose} type="button">
              {t("canvasSetup.done")}
            </button>
          </div>
        </section>
      )}
    </SheetFrame>
  );
}
