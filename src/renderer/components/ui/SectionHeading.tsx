import type { ReactElement, ReactNode } from "react";

import { Badge } from "./Badge";

export function SectionHeading({
  count,
  hint,
  title,
}: Readonly<{ title: ReactNode; count?: number; hint?: ReactNode }>): ReactElement {
  return (
    <div className="ui-section-heading">
      <strong>{title}</strong>
      {count !== undefined ? <Badge variant="count">{count}</Badge> : null}
      {hint ? <span>{hint}</span> : null}
    </div>
  );
}
