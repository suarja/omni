import type { ReactElement, ReactNode } from "react";
import type { AcademyIllustration } from "../../../shared/academy-ipc";
import { Illustration } from "../../learn/Illustration";

type EmptyStateProps = Readonly<{
  actions?: ReactNode;
  ariaLive?: "polite" | "assertive";
  busy?: boolean;
  className?: string;
  children?: ReactNode;
  description: ReactNode;
  icon?: ReactNode;
  illustration?: AcademyIllustration;
  title: ReactNode;
}>;

export function EmptyState({
  actions,
  ariaLive,
  busy = false,
  className,
  children,
  description,
  icon,
  illustration,
  title,
}: EmptyStateProps): ReactElement {
  return (
    <section
      aria-busy={busy || undefined}
      aria-live={ariaLive}
      className={["ui-empty-state", className].filter(Boolean).join(" ")}
    >
      {illustration ? <Illustration className="ui-empty-state__illustration" pictogram={illustration} /> : null}
      {!illustration && icon ? <div className="ui-empty-state__icon">{icon}</div> : null}
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
      {actions ? <div className="ui-empty-state__actions">{actions}</div> : null}
    </section>
  );
}
