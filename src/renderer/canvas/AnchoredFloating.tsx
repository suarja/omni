import { positionFloatingMenu } from "./floating-position";
import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./floating.css";

export function AnchoredFloating(
  props: Readonly<{
    anchor: HTMLElement | null;
    kind: "menu" | "pop";
    children: ReactNode;
    onClose: () => void;
    busy?: boolean;
    className?: string;
    label?: string;
    testId?: string;
  }>,
): ReactElement | null {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const canvas =
    props.anchor?.closest<HTMLElement>(".resource-canvas") ?? document.querySelector<HTMLElement>(".resource-canvas");
  useLayoutEffect(() => {
    const floating = element.current;
    if (!floating || !canvas || !props.anchor) return;
    const measure = (): void => {
      const trigger = props.anchor!.getBoundingClientRect();
      const bounds = canvas.getBoundingClientRect();
      if (props.kind === "menu") {
        const body = props.anchor!.closest(".sheet")?.querySelector(".sh-body");
        setPosition(
          positionFloatingMenu(
            bounds,
            trigger,
            { width: floating.offsetWidth, height: floating.offsetHeight },
            body?.getBoundingClientRect().bottom ?? bounds.bottom,
          ),
        );
        return;
      }
      setPosition({
        left: Math.max(
          12,
          Math.min(trigger.right - bounds.left - floating.offsetWidth, bounds.width - floating.offsetWidth - 12),
        ),
        top: Math.max(12, Math.min(trigger.bottom - bounds.top + 6, bounds.height - floating.offsetHeight - 12)),
      });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(floating);
    observer?.observe(props.anchor);
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    const outside = (event: PointerEvent): void => {
      if (
        !props.busy &&
        event.target instanceof Node &&
        !floating.contains(event.target) &&
        !props.anchor?.contains(event.target)
      )
        props.onClose();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!props.busy) props.onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [props.anchor, canvas, props.busy, props.onClose, props.kind]);
  if (!canvas) return null;
  return createPortal(
    <div
      ref={element}
      role={props.kind === "menu" ? "menu" : "dialog"}
      aria-label={props.label}
      className={`${props.kind} canvas-${props.kind} ${props.className ?? ""}`}
      data-testid={props.testId}
      style={position}
    >
      {props.children}
    </div>,
    canvas,
  );
}
