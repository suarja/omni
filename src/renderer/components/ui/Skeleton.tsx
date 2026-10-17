import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import "./skeleton.css";

type SkeletonProps = Readonly<{
  shape?: "block" | "line" | "circle";
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  radius?: CSSProperties["borderRadius"];
}>;

export function Skeleton({ shape = "block", width, height, radius }: SkeletonProps): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={`ui-skeleton ui-skeleton--${shape}`}
      style={{ width, height, borderRadius: radius }}
    />
  );
}

type LoadingSkeletonProps = Readonly<{
  label: ReactNode;
  variant?: "rows" | "document" | "cards" | "inline" | "settings";
  rows?: number;
  shapes?: ReactNode;
  dataTestId?: string;
}>;

export function LoadingSkeleton({
  label,
  variant = "rows",
  rows = 3,
  shapes,
  dataTestId = "loading-skeleton",
}: LoadingSkeletonProps): ReactElement {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, []);
  const Container = variant === "inline" ? "span" : "div";
  const Shapes = variant === "inline" ? "span" : "div";
  return (
    <Container
      className={`ui-loading-skeleton ui-loading-skeleton--${variant}`}
      data-testid={dataTestId}
      data-visible={visible}
      role="status"
      aria-busy="true"
      aria-label={typeof label === "string" ? label : undefined}
    >
      <span className="ui-skeleton-label">{label}</span>
      <Shapes className="ui-skeleton-shapes" aria-hidden="true">
        {shapes ??
          (variant === "inline" ? (
            <Skeleton shape="line" />
          ) : (
            Array.from({ length: rows }, (_, index) => (
              <div className="ui-skeleton-row" key={index}>
                {variant === "rows" || variant === "cards" ? <Skeleton width={34} height={34} radius={8} /> : null}
                <div className="ui-skeleton-copy">
                  <Skeleton shape="line" width={variant === "document" ? "92%" : "68%"} />
                  <Skeleton shape="line" width={variant === "document" ? "78%" : "44%"} />
                </div>
              </div>
            ))
          ))}
      </Shapes>
    </Container>
  );
}

/** Keep the reserved region and received content stable while reads refresh in the background. */
export function LoadingBoundary({
  loading,
  label,
  children,
  minHeight,
  ...props
}: LoadingSkeletonProps &
  Readonly<{ loading: boolean; children: ReactNode; minHeight?: CSSProperties["minHeight"] }>): ReactElement {
  const [received, setReceived] = useState(!loading);
  const content = useRef(children);
  useEffect(() => {
    if (!loading) {
      content.current = children;
      setReceived(true);
    }
  }, [loading, children]);
  const initial = loading && !received;
  return (
    <div className="ui-loading-boundary" aria-busy={loading} style={{ minHeight }}>
      {initial ? <LoadingSkeleton label={label} {...props} /> : loading ? content.current : children}
    </div>
  );
}
