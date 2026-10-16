import { AddSourceFields } from "../external-library/AddSourceFields";
import { AddStorefrontSheet } from "../storefronts/AddStorefrontSheet";
import { activeWorkshop } from "../../../domain/source-roles";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useI18n } from "../../i18n";
import { SheetFrame } from "../SheetFrame";
import { Glossary } from "../Glossary";
import { MarketplaceCreateForm } from "./MarketplaceSetupSheet";
import type { WorkspaceSetupInputs } from "./workspace-setup-types";
import type { WorkspaceSetupActions, WorkspaceSetupState } from "./use-workspace-setup";
import "../new-skill.css";
import "./add-resource.css";

export function AddMarketplaceSheet(
  props: Readonly<{
    setup: WorkspaceSetupInputs;
    state: WorkspaceSetupState;
    actions: WorkspaceSetupActions;
    onClose: () => void;
    onApplyingChange: (busy: boolean) => void;
    initialRepository?: string;
  }>,
): ReactElement {
  const { t } = useI18n();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!props.state.ownership) props.actions.setOwnership("external");
  }, [props.state.ownership]);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  const [storefrontOpen, setStorefrontOpen] = useState(false);
  const [sourceAdding, setSourceAdding] = useState(false);
  const [sourceFooter, setSourceFooter] = useState<HTMLDivElement | null>(null);
  const busy = props.state.busy || sourceAdding;
  const mine = props.state.ownership === "personal";
  const current = activeWorkshop(props.setup.snapshot.registry);
  const creating = props.state.marketplaceMode === "create";
  if (storefrontOpen && current)
    return (
      <AddStorefrontSheet
        setup={props.setup}
        onClose={props.onClose}
        onApplyingChange={props.onApplyingChange}
        onExternal={() => {
          setStorefrontOpen(false);
          props.actions.setOwnership("external");
        }}
      />
    );
  return (
    <SheetFrame
      title={t("addResource.marketplace")}
      kicker={
        <>
          {t("addResource.kicker")} <Glossary concept="marketplace" />
        </>
      }
      testId="canvas-setup-sheet"
      className="add-resource-sheet"
      onClose={props.onClose}
      busy={busy}
      focusClose={false}
      footer={
        <>
          <button
            ref={cancel}
            className="canvas-secondary-button"
            type="button"
            disabled={busy}
            onClick={props.onClose}
          >
            {t("addResource.cancel")}
          </button>
          <span className="skill-footer-note" />
          {!mine && !creating ? <div className="external-source-footer" ref={setSourceFooter} /> : null}
          {!creating && mine ? (
            <button
              className="canvas-secondary-button is-primary"
              type="button"
              disabled={busy || !props.setup.api}
              onClick={() => void props.actions.connectSource()}
            >
              {t("addResource.add")}
            </button>
          ) : null}
        </>
      }
    >
      <div className="skill-field">
        <div className="new-skill-segment">
          {(["external", "personal"] as const).map((ownership) => (
            <button
              type="button"
              key={ownership}
              disabled={busy}
              data-testid={ownership === "external" ? "canvas-setup-choice-external" : "canvas-setup-choice-existing"}
              aria-pressed={props.state.ownership === ownership}
              onClick={() =>
                current && ownership === "personal" ? setStorefrontOpen(true) : props.actions.setOwnership(ownership)
              }
            >
              {t(
                ownership === "external" ? "addResource.external" : current ? "storefronts.addTab" : "addResource.mine",
              )}
            </button>
          ))}
        </div>
      </div>
      {creating ? (
        <MarketplaceCreateForm
          api={props.setup.api}
          onApplied={props.actions.createdSource}
          onReceipt={props.actions.retainCreationReceipt}
          onApplyingChange={props.onApplyingChange}
          onBack={() => props.actions.setMarketplaceMode("connect")}
        />
      ) : mine ? (
        <>
          <p className="add-resource-copy is-first">
            {current ? (
              <>
                {t("addResource.currentBefore")}
                <b>{current.displayName}</b>
                {t("addResource.currentAfter")}
              </>
            ) : (
              t("addResource.firstHint")
            )}
          </p>
          <div className="skill-field">
            <span className="skill-label">{t("addResource.repository")}</span>
            <div className="add-resource-stack">
              <button
                className="canvas-secondary-button"
                data-testid="canvas-setup-connect-source"
                type="button"
                disabled={busy || !props.setup.api}
                onClick={() => void props.actions.connectSource()}
              >
                {t("addResource.choose")}
              </button>
              <button
                className="canvas-secondary-button"
                data-testid="canvas-setup-choice-create"
                type="button"
                disabled={busy || !props.setup.api}
                onClick={() => props.actions.setMarketplaceMode("create")}
              >
                {t("addResource.create")}
              </button>
            </div>
          </div>
        </>
      ) : (
        <AddSourceFields
          initialRepository={props.initialRepository}
          actionTarget={sourceFooter}
          folderAvailable={Boolean(props.setup.api)}
          folderBusy={busy}
          onApplyingChange={(active) => {
            setSourceAdding(active);
            props.onApplyingChange(active);
          }}
          onFolder={() => void props.actions.connectSource()}
        />
      )}
      {props.state.error ? (
        <p className="skill-error" role="alert">
          {props.state.error}
        </p>
      ) : null}
      {props.state.refreshAvailable ? (
        <button
          className="canvas-secondary-button"
          disabled={props.state.refreshing}
          onClick={() => void props.actions.refreshWorkspace()}
        >
          {t("canvasSetup.refreshWorkspace")}
        </button>
      ) : null}
      {props.state.conflictEntry ? (
        <button
          className="canvas-secondary-button"
          onClick={() => props.actions.acceptConflict(props.state.conflictEntry!)}
        >
          {t("canvasSetup.readExistingSource")}
        </button>
      ) : null}
    </SheetFrame>
  );
}
