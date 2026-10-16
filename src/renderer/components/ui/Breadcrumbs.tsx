import type { ReactElement } from "react";

export type BreadcrumbItem = Readonly<{ label: string; onClick?: () => void }>;

export function Breadcrumbs({ items }: Readonly<{ items: readonly BreadcrumbItem[] }>): ReactElement {
  return (
    <nav aria-label="Breadcrumb" className="ui-breadcrumbs">
      {items.map((item, index) => (
        <span className="ui-breadcrumbs__item" key={`${item.label}-${index}`}>
          {index > 0 ? (
            <span aria-hidden="true" className="ui-breadcrumbs__separator">
              /
            </span>
          ) : null}
          {item.onClick ? (
            <button onClick={item.onClick} type="button">
              {item.label}
            </button>
          ) : (
            <span aria-current="page">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
