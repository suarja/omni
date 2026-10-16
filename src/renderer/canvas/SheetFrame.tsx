import { useEffect, useRef, type ReactElement, type ReactNode, type RefObject, type KeyboardEventHandler } from "react";
import { useI18n } from "../i18n";
import { SheetResizeHandle } from "./SheetResizeHandle";
import "./sheet-frame.css";

export function SheetFrame(
  props: Readonly<{
    closeRef?: RefObject<HTMLButtonElement | null>;
    closeLabel?: string;
    headerClassName?: string;
    footerClassName?: string;
    title: string;
    subtitle?: ReactNode;
    kicker: ReactNode;
    children: ReactNode;
    tabs?: ReactNode;
    footer?: ReactNode;
    testId: string;
    onClose: () => void;
    busy?: boolean;
    className?: string;
    bodyClassName?: string;
    label?: string;
    modal?: boolean;
    inert?: boolean;
    resizeKind?: "details" | "document" | "setup" | "changes";
    sheetRef?: RefObject<HTMLDivElement | null>;
    onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
    focusClose?: boolean;
  }>,
): ReactElement {
  const { t } = useI18n();
  const ownClose = useRef<HTMLButtonElement>(null);
  const close = props.closeRef ?? ownClose;
  useEffect(() => {
    if (props.focusClose !== false) close.current?.focus();
  }, []);
  return (
    <section
      role="dialog"
      aria-label={props.label ?? props.title}
      aria-modal={props.modal}
      aria-busy={props.busy}
      inert={props.inert}
      ref={props.sheetRef}
      onKeyDown={props.onKeyDown}
      className={`sheet canvas-sheet project-sheet is-document ${props.className ?? ""}`}
      data-testid={props.testId}
      tabIndex={-1}
    >
      <SheetResizeHandle kind={props.resizeKind ?? "document"} />
      <header className={`sh-head canvas-sheet-header ${props.headerClassName ?? ""}`}>
        <div>
          <div className="sh-kicker canvas-meta-label">{props.kicker}</div>
          <h2 className="sh-title">{props.title}</h2>
          {props.subtitle ? <div className="sh-sub">{props.subtitle}</div> : null}
        </div>
        <button
          ref={close}
          type="button"
          className="sh-close canvas-icon-button"
          aria-label={props.closeLabel ?? t("canvas.close")}
          disabled={props.busy}
          onClick={props.onClose}
        >
          ×
        </button>
      </header>
      {props.tabs ? <div className="tabs">{props.tabs}</div> : null}
      <div className={`sh-body canvas-sheet-body ${props.bodyClassName ?? ""}`}>{props.children}</div>
      {props.footer ? (
        <footer className={`sh-foot project-sheet-footer ${props.footerClassName ?? ""}`}>{props.footer}</footer>
      ) : null}
    </section>
  );
}
