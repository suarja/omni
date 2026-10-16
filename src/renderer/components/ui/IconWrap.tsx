import type { ReactElement } from "react";

import { Icon, type IconName } from "../Icon";

export function IconWrap({
  name,
  size = "default",
}: Readonly<{ name: IconName; size?: "default" | "sm" }>): ReactElement {
  return (
    <span aria-hidden="true" className={`ui-icon-wrap${size === "sm" ? " ui-icon-wrap--sm" : ""}`}>
      <Icon name={name} size={size === "sm" ? 15 : 18} />
    </span>
  );
}
