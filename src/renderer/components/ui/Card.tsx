import type { ReactElement, ReactNode } from "react";

type CardProps = Readonly<{
  children: ReactNode;
  className?: string;
  dataTestId?: string;
  raised?: boolean;
}>;

type CardHeaderProps = Readonly<{
  actions?: ReactNode;
  count?: ReactNode;
  hint?: ReactNode;
  title: ReactNode;
}>;

type CardFootProps = Readonly<{
  children: ReactNode;
  className?: string;
}>;

function joinClasses(...classes: readonly (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function Card({ children, className, dataTestId, raised = false }: CardProps): ReactElement {
  return (
    <section className={joinClasses("ui-card", raised && "ui-card--raised", className)} data-testid={dataTestId}>
      {children}
    </section>
  );
}

export function CardHeader({ actions, count, hint, title }: CardHeaderProps): ReactElement {
  return (
    <header className="ui-card__header">
      <strong className="ui-card__header-title">{title}</strong>
      {count}
      <span className="ui-card__header-spacer" />
      {hint ? <span className="ui-card__header-hint">{hint}</span> : null}
      {actions ? <div className="ui-card__header-actions">{actions}</div> : null}
    </header>
  );
}

export function CardFoot({ children, className }: CardFootProps): ReactElement {
  return <footer className={joinClasses("ui-card__foot", className)}>{children}</footer>;
}
