import type { ReactElement } from "react";

import { Badge } from "./Badge";

export type TabItem = Readonly<{ id: string; label: string; count?: number; dataTestId?: string; onClick: () => void }>;

export function Tabs({
  ariaLabel,
  items,
  selected,
}: Readonly<{ ariaLabel: string; items: readonly TabItem[]; selected: string }>): ReactElement {
  return (
    <div aria-label={ariaLabel} className="ui-tabs" role="tablist">
      {items.map((item) => (
        <button
          aria-selected={item.id === selected}
          className={item.id === selected ? "is-active" : undefined}
          data-testid={item.dataTestId}
          key={item.id}
          onClick={item.onClick}
          role="tab"
          type="button"
        >
          {item.label}
          {item.count !== undefined ? <Badge variant="count">{item.count}</Badge> : null}
        </button>
      ))}
    </div>
  );
}
