import type { MouseEventHandler, ReactElement, ReactNode } from "react";

import { Icon, type IconName } from "../Icon";

export type ButtonTone = "primary" | "secondary" | "outline" | "ghost";
export type ButtonSize = "small" | "medium";

export type ButtonProps = Readonly<{
  children: ReactNode;
  ariaLabel?: string;
  ariaExpanded?: boolean;
  dataTestId?: string;
  disabled?: boolean;
  icon?: IconName;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  size?: ButtonSize;
  tone?: ButtonTone;
  type?: "button" | "submit" | "reset";
}>;

export function Button({
  ariaLabel,
  ariaExpanded,
  dataTestId,
  children,
  disabled = false,
  icon,
  onClick,
  size = "medium",
  tone = "primary",
  type = "button",
}: ButtonProps): ReactElement {
  return (
    <button
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      className={`ui-button ui-button--${tone} ui-button--${size}`}
      data-testid={dataTestId}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {icon ? <Icon name={icon} /> : null}
      <span className="ui-button__label">{children}</span>
    </button>
  );
}
