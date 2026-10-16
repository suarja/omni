import type { ReactElement, ReactNode } from "react";

export type BadgeVariant = "type" | "status" | "count";
export type BadgeTone = "ok" | "warn" | "bad" | "neutral";

type BadgeProps = Readonly<{
  children: ReactNode;
  className?: string;
  dataTestId?: string;
  dotTone?: BadgeTone;
  tone?: BadgeTone;
  variant: BadgeVariant;
}>;

export function Badge({
  children,
  className,
  dataTestId,
  dotTone,
  tone = "neutral",
  variant,
}: BadgeProps): ReactElement {
  const classes = ["ui-badge", `ui-badge--${variant}`, `ui-badge--tone-${tone}`, className].filter(Boolean).join(" ");
  return (
    <span className={classes} data-testid={dataTestId}>
      {variant === "status" ? <span className={`ui-badge__dot ui-badge__dot--${dotTone ?? tone}`} /> : null}
      {children}
    </span>
  );
}
