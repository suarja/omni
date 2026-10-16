import type { ReactElement, ReactNode } from "react";

import type { IconName } from "../components/Icon";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { IconWrap } from "../components/ui/IconWrap";

export function ActivityTile({
  badge,
  badgeTone = "bad",
  dataTestId,
  icon,
  meta,
  name,
  onClick,
}: Readonly<{
  badge?: ReactNode;
  badgeTone?: BadgeTone;
  dataTestId: string;
  icon: IconName;
  meta: string;
  name: string;
  onClick: () => void;
}>): ReactElement {
  return (
    <button className="activity-tile" data-testid={dataTestId} onClick={onClick} type="button">
      <span className="activity-tile__top">
        <IconWrap name={icon} />
        <span className="activity-tile__copy">
          <span className="activity-tile__name">
            {name}
            {badge ? (
              <Badge tone={badgeTone} variant="status">
                {badge}
              </Badge>
            ) : null}
          </span>
        </span>
      </span>
      <span className="activity-tile__meta">{meta}</span>
    </button>
  );
}
