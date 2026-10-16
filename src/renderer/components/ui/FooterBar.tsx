import type { ReactElement, ReactNode } from "react";

type FooterBarProps = Readonly<{
  actions?: ReactNode;
  className?: string;
  note?: ReactNode;
}>;

export function FooterBar({ actions, className, note }: FooterBarProps): ReactElement {
  return (
    <footer className={["ui-footer-bar", className].filter(Boolean).join(" ")}>
      {actions ? <div className="ui-footer-bar__actions">{actions}</div> : null}
      {note ? <span className="ui-footer-bar__note">{note}</span> : null}
    </footer>
  );
}
