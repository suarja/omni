import type { MouseEventHandler, ReactElement, ReactNode } from "react";

type ListItemProps = Readonly<{
  ariaLabel?: string;
  ariaPressed?: boolean;
  leading?: ReactNode;
  name: ReactNode;
  badges?: ReactNode;
  sub?: ReactNode;
  side?: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  dim?: boolean;
  selected?: boolean;
  variant?: "default" | "dashed";
  dataTestId?: string;
  className?: string;
}>;

function content({ ariaPressed, badges, leading, name, side, sub, onClick }: ListItemProps): ReactElement {
  return (
    <>
      {leading ? <span className="ui-item__leading">{leading}</span> : null}
      <span className="ui-item__copy">
        <span className="ui-item__name">
          {name}
          {badges ? <span className="ui-item__badges">{badges}</span> : null}
        </span>
        {sub ? <span className="ui-item__sub">{sub}</span> : null}
      </span>
      {side ? <span className="ui-item__side">{side}</span> : null}
      {onClick && ariaPressed === undefined ? (
        <span aria-hidden="true" className="ui-item__chevron">
          ›
        </span>
      ) : null}
    </>
  );
}

export function ListItem(props: ListItemProps): ReactElement {
  const className = [
    "ui-item",
    props.dim && "ui-item--dim",
    props.onClick && "ui-item--clickable",
    props.selected && "is-selected",
    props.variant === "dashed" && "ui-item--dashed",
    props.className,
  ]
    .filter(Boolean)
    .join(" ");
  return props.onClick ? (
    <button
      aria-label={props.ariaLabel}
      aria-pressed={props.ariaPressed}
      className={className}
      data-testid={props.dataTestId}
      onClick={props.onClick}
      type="button"
    >
      {content(props)}
    </button>
  ) : (
    <div className={className} data-testid={props.dataTestId}>
      {content(props)}
    </div>
  );
}

export type ItemListVariant = "standalone" | "nested" | "tree";

type ItemListProps = Readonly<{
  children: ReactNode;
  className?: string;
  variant?: ItemListVariant;
}>;

export function ItemList({ children, className, variant = "standalone" }: ItemListProps): ReactElement {
  const listClassName = [
    "ui-item-list",
    variant === "nested" && "ui-item-list--nested",
    variant === "tree" && "ui-item-list--tree",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <div className={listClassName}>{children}</div>;
}
