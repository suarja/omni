import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import type { Route } from "../../navigation";
import type { DesktopApi } from "../../../shared/ipc";
import { useI18n } from "../../i18n";
import { isReceiptRestorable } from "../../review/CompletedOperations";
import { SheetFrame } from "../SheetFrame";
import { WorkbenchTabs } from "./WorkbenchTabs";
import "./changes.css";
import "./workflow.css";

export function WorkflowWorkbench(
  props: Readonly<{
    title: string;
    api?: Partial<DesktopApi> | null;
    subtitle?: string;
    children: ReactNode;
    targets?: ReactNode;
    footer?: ReactNode;
    notice?: ReactNode;
    hasResult?: boolean;
    busy: boolean;
    onClose: () => void;
    receipt?: OperationReceipt | null;
    onNavigate?: (route: Route) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const close = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<"diff" | "targets" | "result">("diff");
  const [receipts, setReceipts] = useState<readonly OperationReceipt[]>([]);
  useEffect(() => {
    let active = true;
    setReceipts([]);
    if (!props.receipt || !props.api?.listOperations) return;
    const load = (): void => {
      void props.api!.listOperations!()
        .then((response) => {
          if (active) setReceipts(response.status === "ready" ? response.receipts : []);
        })
        .catch(() => {
          if (active) setReceipts([]);
        });
    };
    load();
    const unsubscribe = props.api.onReviewChanged?.(load);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [props.api, props.receipt]);
  const tab = props.hasResult ? "result" : selected === "result" ? "diff" : selected;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const key = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!props.busy) props.onClose();
    }
    if (event.key !== "Tab") return;
    const controls = [
      ...(sheet.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"], a[href]',
      ) ?? []),
    ].filter((control) => !control.closest("[hidden]"));
    const destination = event.shiftKey ? controls.at(-1) : controls[0];
    const boundary = event.shiftKey ? controls[0] : controls.at(-1);
    if (document.activeElement === boundary && destination) {
      event.preventDefault();
      destination.focus();
    }
  };
  const currentReceipt = receipts.find((item) => item.operationId === props.receipt?.operationId);
  const restorable =
    props.receipt &&
    isReceiptRestorable(props.receipt, receipts) &&
    currentReceipt &&
    isReceiptRestorable(currentReceipt, receipts);
  return (
    <SheetFrame
      title={props.title}
      kicker={t("skillManagement.title")}
      subtitle={props.subtitle}
      sheetRef={sheet}
      closeRef={close}
      focusClose={false}
      closeLabel={t("skillManagement.close")}
      modal
      busy={props.busy}
      onClose={props.onClose}
      onKeyDown={key}
      className="changes-workbench changes-workflow"
      testId="changes-workbench"
      resizeKind="changes"
      headerClassName="changes-header"
      tabs={
        <WorkbenchTabs
          tab={tab}
          propagation={false}
          hasResult={Boolean(props.hasResult)}
          hasPreview={!props.hasResult}
          restoreMode={false}
          onChange={setSelected}
          t={t}
          labels={{
            diff: t("skillManagement.workflowPreview"),
            targets: t("skillManagement.copyManagementTab.effects"),
            result: t("skillManagement.result"),
          }}
        />
      }
      footer={
        <>
          {props.footer}
          {props.hasResult && restorable && props.onNavigate ? (
            <div className="changes-actions">
              <button
                className="changes-secondary"
                type="button"
                disabled={props.busy}
                data-testid="workbench-restore"
                onClick={() =>
                  props.onNavigate?.({ screen: "operation-restore", operationId: props.receipt!.operationId })
                }
              >
                {t(props.receipt?.kind === "register-project" ? "projectView.undo" : "receipt.restore")}
              </button>
            </div>
          ) : null}
        </>
      }
    >
      {props.notice ? <div className="changes-workflow-notice">{props.notice}</div> : null}
      <fieldset
        disabled={props.busy}
        className="changes-body"
        role="tabpanel"
        id={`changes-panel-${tab}`}
        aria-labelledby={`changes-tab-${tab}`}
        tabIndex={0}
      >
        <div hidden={tab !== (props.hasResult ? "result" : "diff")}>{props.children}</div>
        <div hidden={tab !== "targets"}>{props.targets ?? <p>{t("assignment.nothingWritten")}</p>}</div>
      </fieldset>
    </SheetFrame>
  );
}
