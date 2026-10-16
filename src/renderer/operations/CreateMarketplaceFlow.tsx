import type { ReactElement } from "react";

import type { DesktopApi } from "../../shared/ipc";
import type {
  OperationAction,
  OperationActionReceipt,
  OperationPlan,
  OperationReceipt,
} from "../../shared/operations-ipc";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Callout } from "../components/ui/Callout";
import { Card, CardFoot, CardHeader } from "../components/ui/Card";
import { FooterBar } from "../components/ui/FooterBar";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { useI18n } from "../i18n";
import { useMarketplaceCreation } from "./use-marketplace-creation";

type FlowProps = Readonly<{
  activePersonalSource?: boolean;
  api: DesktopApi | null;
  onApplied: (receipt: OperationReceipt) => void;
  onCancel?: () => void;
  onComplete?: () => void;
}>;

function gitLabel(
  mode: OperationPlan["git"]["mode"],
  commit: string | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (commit) return t("marketplaceFlow.gitCommit", { commit: commit.slice(0, 7) });
  if (mode === "init-and-commit") return t("marketplaceFlow.gitInit");
  if (mode === "enclosing-repository") return t("marketplaceFlow.gitEnclosing");
  return t("marketplaceFlow.gitUnavailable");
}

function actionLabel(action: OperationAction, plan: OperationPlan, t: ReturnType<typeof useI18n>["t"]): string {
  if (action.kind === "create-directory")
    return t("marketplaceFlow.folder", {
      path: action.relativePath === "." ? plan.displayTarget : action.relativePath,
    });
  return t("marketplaceFlow.file", { path: action.relativePath, size: action.byteLength ?? 0 });
}

function actionStatusLabel(status: OperationActionReceipt["status"], t: ReturnType<typeof useI18n>["t"]): string {
  return t(`marketplaceFlow.actionStatus.${status}` as Parameters<typeof t>[0]);
}

function actionStatusTone(status: OperationActionReceipt["status"]): BadgeTone {
  return status === "applied" ? "ok" : status === "failed" ? "bad" : "warn";
}

function ActionReceipt({
  plan,
  receipt,
  t,
}: Readonly<{
  plan: OperationPlan | null;
  receipt: OperationReceipt;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  return (
    <div data-testid="marketplace-create-failure-actions">
      <Card>
        <CardHeader title={t("marketplaceFlow.actionResultTitle")} />
        <ItemList variant="nested">
          {receipt.actions.map((action) => (
            <ListItem
              badges={
                <Badge tone={actionStatusTone(action.status)} variant="status">
                  {actionStatusLabel(action.status, t)}
                </Badge>
              }
              key={`${action.kind}:${action.relativePath}`}
              name={plan ? actionLabel(action, plan, t) : action.relativePath}
              sub={<span className="ui-item__mono">{action.relativePath}</span>}
            />
          ))}
        </ItemList>
      </Card>
    </div>
  );
}

function PreviewCard({
  plan,
  busy,
  onApply,
  onChange,
  t,
}: Readonly<{
  plan: OperationPlan;
  busy: boolean;
  onApply: () => void;
  onChange: () => void;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  return (
    <>
      <div data-testid="marketplace-create-preview-result">
        <Card>
          <CardHeader title={t("marketplaceFlow.actionsTitle")} />
          <ItemList variant="nested">
            {plan.actions
              .filter((action) => action.relativePath !== "packages")
              .map((action) => (
                <ListItem key={`${action.kind}:${action.relativePath}`} name={actionLabel(action, plan, t)} />
              ))}
            <ListItem name={t("marketplaceFlow.git")} sub={gitLabel(plan.git.mode, undefined, t)} />
          </ItemList>
        </Card>
      </div>
      {plan.git.warnings.map((warning) => (
        <Callout key={warning} title={t("marketplaceFlow.warningTitle")} tone="warning">
          {warning}
        </Callout>
      ))}
      <FooterBar
        actions={
          <>
            <span data-testid="marketplace-create-apply">
              <Button dataTestId="create-marketplace-apply" disabled={busy} onClick={onApply}>
                {t("marketplaceFlow.create")}
              </Button>
            </span>
            <Button dataTestId="marketplace-create-change" disabled={busy} onClick={onChange} tone="ghost">
              {t("marketplaceFlow.change")}
            </Button>
          </>
        }
      />
    </>
  );
}

export function CreateMarketplaceFlow({
  activePersonalSource = false,
  api,
  onApplied,
  onCancel = () => undefined,
  onComplete = () => undefined,
}: FlowProps): ReactElement {
  const { t } = useI18n();
  const { state, actions } = useMarketplaceCreation({ api, onApplied });
  const {
    parent,
    name,
    slug,
    validName,
    validation,
    preview: previewState,
    lastPlan,
    receipt,
    registered,
    diagnostic,
    busy,
    applying,
  } = state;

  if (activePersonalSource && !receipt)
    return (
      <div className="create-marketplace-flow" data-testid="create-marketplace-flow">
        <Card className="create-marketplace-flow--disabled">
          <CardHeader title={t("marketplaceFlow.location")} />
          <CardFoot>{t("marketplaceFlow.archiveFirst")}</CardFoot>
        </Card>
        <FooterBar
          actions={
            <Button dataTestId="marketplace-create-cancel" onClick={onCancel} tone="ghost">
              {t("marketplaceFlow.cancel")}
            </Button>
          }
        />
      </div>
    );

  return (
    <div className="create-marketplace-flow" data-testid="create-marketplace-flow">
      <Card>
        <CardHeader title={t("marketplaceFlow.location")} />
        <ItemList variant="nested">
          <ListItem
            name={
              <span className="marketplace-create-field">
                <span>{t("marketplaceFlow.parent")}</span>
                <span className="marketplace-create-field__row">
                  <input
                    aria-label={t("marketplaceFlow.parent")}
                    data-testid="marketplace-create-parent"
                    readOnly
                    value={parent?.display ?? t("marketplaceFlow.notChosen")}
                  />
                  <Button
                    dataTestId="create-marketplace-pick-parent"
                    disabled={busy}
                    onClick={() => void actions.chooseParent()}
                    size="small"
                    tone="ghost"
                  >
                    {t("marketplaceFlow.chooseParent")}
                  </Button>
                </span>
              </span>
            }
            sub={parent?.display ? <span className="ui-item__mono">{parent.display}</span> : undefined}
          />
          <ListItem
            name={
              <span className="marketplace-create-field">
                <span>{t("marketplaceFlow.name")}</span>
                <input
                  aria-describedby="marketplace-create-name-help"
                  aria-label={t("marketplaceFlow.name")}
                  data-testid="marketplace-create-name"
                  disabled={applying}
                  onChange={(event) => actions.setName(event.target.value)}
                  value={name}
                />
                <code className="create-marketplace-slug">{slug || "—"}</code>
                <span className="marketplace-create-validation" id="marketplace-create-name-help">
                  {validation}
                </span>
              </span>
            }
          />
        </ItemList>
      </Card>
      <FooterBar
        actions={
          <>
            <span data-testid="marketplace-create-preview">
              <Button
                dataTestId="create-marketplace-preview"
                disabled={busy || !parent || !validName}
                onClick={() => void actions.preview()}
              >
                {t("marketplaceFlow.preview")}
              </Button>
            </span>
            <Button dataTestId="marketplace-create-cancel" disabled={applying} onClick={onCancel} tone="ghost">
              {t("marketplaceFlow.cancel")}
            </Button>
          </>
        }
      />
      {diagnostic && !receipt && previewState?.kind !== "blocked" ? (
        <Callout title={t("marketplaceFlow.failed")} tone="error">
          {diagnostic}
        </Callout>
      ) : null}
      {previewState?.kind === "blocked" ? (
        <Callout title={t("marketplaceFlow.blockedTitle")} tone="warning">
          {previewState.reason}: {previewState.diagnostic}
        </Callout>
      ) : null}
      {previewState?.kind === "ready" ? (
        <PreviewCard
          busy={busy}
          onApply={() => void actions.apply()}
          onChange={actions.changePreview}
          plan={previewState.plan}
          t={t}
        />
      ) : null}
      {receipt?.status === "applied" && registered ? (
        <div data-testid="marketplace-create-result">
          <Card>
            <CardHeader
              title={t("marketplaceFlow.created")}
              count={
                <Badge tone="ok" variant="status">
                  {t("marketplaceFlow.ok")}
                </Badge>
              }
            />
            <ItemList variant="nested">
              <ListItem name={t("marketplaceFlow.folder", { path: receipt.displayTarget })} />
              <ListItem
                name={t("marketplaceFlow.files", {
                  count: receipt.actions.filter((action) => action.kind === "write-file").length,
                })}
              />
              <ListItem name={t("marketplaceFlow.git")} sub={gitLabel(receipt.git.mode, receipt.git.commit, t)} />
              <ListItem name={t("marketplaceFlow.registered")} />
            </ItemList>
            <CardFoot>{t("marketplaceFlow.createdFoot")}</CardFoot>
          </Card>
        </div>
      ) : null}
      {receipt?.status === "applied" && registered ? (
        <FooterBar
          actions={
            <span data-testid="marketplace-create-continue">
              <Button onClick={onComplete}>{t("marketplaceFlow.continue")}</Button>
            </span>
          }
        />
      ) : null}
      {receipt?.status === "failed" ? (
        <>
          <Callout title={t("marketplaceFlow.failed")} tone="error">
            {diagnostic ?? t("marketplaceFlow.failed")}
          </Callout>
          <ActionReceipt plan={lastPlan} receipt={receipt} t={t} />
        </>
      ) : null}
      {receipt?.status === "applied" && !registered ? (
        <Callout title={t("marketplaceFlow.failed")} tone="error">
          {diagnostic ?? t("registry.registrationFailed")}
        </Callout>
      ) : null}
    </div>
  );
}
