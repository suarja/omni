import type { MouseEventHandler, ReactElement } from "react";

import { Icon, type IconName } from "../Icon";

export type IconButtonProps = Readonly<{
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  type?: "button" | "submit" | "reset";
}>;

export function IconButton({ disabled = false, icon, label, onClick, type = "button" }: IconButtonProps): ReactElement {
  if (!label.trim()) {
    throw new Error("IconButton requires a non-empty accessible label.");
  }

  return (
    <button aria-label={label} className="ui-icon-button" disabled={disabled} onClick={onClick} type={type}>
      <Icon name={icon} />
    </button>
  );
}
