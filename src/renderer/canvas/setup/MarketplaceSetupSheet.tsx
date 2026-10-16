import { useEffect, type ReactElement } from "react";

import { Callout } from "../../components/ui/Callout";
import { useI18n } from "../../i18n";
import { useMarketplaceCreation } from "../../operations/use-marketplace-creation";
import type { WorkspaceSetupActions } from "./use-workspace-setup";
import type { WorkspaceSetupInputs } from "./workspace-setup-types";

function gitModeLabel(mode: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (mode === "init-and-commit") return t("canvasSetup.gitInit");
  if (mode === "commit") return t("canvasSetup.gitCommit");
  if (mode === "enclosing-repository") return t("canvasSetup.gitEnclosing");
  if (mode === "not-a-repository") return t("canvasSetup.gitNotRepository");
  if (mode === "disabled") return t("canvasSetup.gitDisabled");
  return t("canvasSetup.gitUnavailable");
}

export function MarketplaceCreateForm(
  props: Readonly<{
    api: WorkspaceSetupInputs["api"];
    onApplied: WorkspaceSetupActions["createdSource"];
    onReceipt: WorkspaceSetupActions["retainCreationReceipt"];
    onApplyingChange: (applying: boolean) => void;
    onBack: () => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const { state, actions } = useMarketplaceCreation({
    api: props.api,
    onApplied: props.onApplied,
    onReceipt: props.onReceipt,
  });
  useEffect(() => {
    props.onApplyingChange(state.applying);
    return () => props.onApplyingChange(false);
  }, [props.onApplyingChange, state.applying]);

  return (
    <div className="canvas-setup-form" data-testid="canvas-setup-create-form">
      <p>{t("canvasSetup.createDescription")}</p>
      <label className="canvas-setup-field">
        <span>{t("marketplaceFlow.parent")}</span>
        <span className="canvas-setup-inline">
          <input
            aria-label={t("marketplaceFlow.parent")}
            readOnly
            value={state.parent?.display ?? t("marketplaceFlow.notChosen")}
          />
          <button
            className="is-secondary"
            data-testid="canvas-setup-marketplace-pick-parent"
            disabled={state.busy || state.applying}
            onClick={() => void actions.chooseParent()}
            type="button"
          >
            {t("marketplaceFlow.chooseParent")}
          </button>
        </span>
      </label>
      <label className="canvas-setup-field">
        <span>{t("marketplaceFlow.name")}</span>
        <input
          aria-describedby="canvas-setup-name-help"
          aria-label={t("marketplaceFlow.name")}
          data-testid="canvas-setup-marketplace-name"
          disabled={state.applying}
          onChange={(event) => actions.setName(event.target.value)}
          value={state.name}
        />
        <code>{state.slug || "—"}</code>
        <small id="canvas-setup-name-help">{state.validation}</small>
      </label>
      {!state.preview ? (
        <div className="canvas-setup-actions">
          <button
            data-testid="canvas-setup-marketplace-preview"
            disabled={state.busy || !state.parent || !state.validName}
            onClick={() => void actions.preview()}
            type="button"
          >
            {state.busy ? t("canvasSetup.previewing") : t("marketplaceFlow.preview")}
          </button>
          <button className="is-secondary" disabled={state.applying} onClick={props.onBack} type="button">
            {t("canvasSetup.back")}
          </button>
        </div>
      ) : null}
      {state.preview?.kind === "blocked" ? (
        <Callout title={t("marketplaceFlow.blockedTitle")} tone="warning">
          {state.preview.reason}: {state.preview.diagnostic}
        </Callout>
      ) : null}
      {state.preview?.kind === "ready" ? (
        <section className="canvas-setup-plan" data-testid="canvas-setup-marketplace-plan">
          <h3>{t("canvasSetup.plannedEffects")}</h3>
          <p>
            {t("canvasSetup.target")}: <code>{state.preview.plan.displayTarget}</code>
          </p>
          <ul>
            {state.preview.plan.actions.map((action) => (
              <li key={`${action.kind}:${action.relativePath}`}>
                <code>{action.relativePath}</code>
              </li>
            ))}
          </ul>
          <p>
            {t("canvasSetup.gitPlan")}: {gitModeLabel(state.preview.plan.git.mode, t)}
          </p>
          {state.preview.plan.git.warnings.map((warning) => (
            <Callout key={warning} title={t("canvasSetup.gitWarning")} tone="warning">
              {warning}
            </Callout>
          ))}
          <div className="canvas-setup-actions">
            <button
              data-testid="canvas-setup-marketplace-apply"
              disabled={state.busy || state.applying}
              onClick={() => void actions.apply()}
              type="button"
            >
              {state.applying ? t("canvasSetup.creating") : t("canvasSetup.create")}
            </button>
            <button className="is-secondary" disabled={state.applying} onClick={actions.changePreview} type="button">
              {t("canvasSetup.refreshPreview")}
            </button>
          </div>
        </section>
      ) : null}
      {state.diagnostic ? (
        <Callout title={t("canvasSetup.actionFailed")} tone="error">
          {state.diagnostic}
        </Callout>
      ) : null}
      {!props.api ? <p className="canvas-setup-unavailable">{t("canvasSetup.apiUnavailable")}</p> : null}
    </div>
  );
}
