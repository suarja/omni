import type { ReactElement, ReactNode } from "react";

export function WorkflowFooter(props: Readonly<{ actions?: ReactNode; note?: ReactNode }>): ReactElement {
  return (
    <footer className="changes-actions">
      {props.note ? <span className="changes-note">{props.note}</span> : null}
      {props.actions}
    </footer>
  );
}
