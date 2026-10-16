import { useId, type ReactElement, type ReactNode } from "react";

export type CalloutTone = "info" | "success" | "warning" | "error";

export type CalloutProps = Readonly<{
  children: ReactNode;
  title: string;
  tone: CalloutTone;
}>;

export function Callout({ children, title, tone }: CalloutProps): ReactElement {
  const titleId = useId();
  const contentId = useId();

  return (
    <div
      aria-describedby={contentId}
      aria-labelledby={titleId}
      className={`ui-callout ui-callout--${tone}`}
      role="alert"
    >
      <strong id={titleId}>{title}</strong>
      <div className="ui-callout__content" id={contentId}>
        {children}
      </div>
    </div>
  );
}
